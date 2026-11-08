/**
 * El panel y las conversiones de Meta (1-nov-2026): marcar «Vendido» con su
 * monto avisa la compra, y Configuración enseña el estado y prueba el envío.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
import { guardarClic } from "../../src/meta/conversiones";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };
const CONV = "whatsapp:50760000000";
let env: Env;
let eventos: any[];
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "PanaClaw",
    BUSINESS_NAME: "PanaClaw",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
    WHATSAPP_ACCESS_TOKEN: "tok",
  } as unknown as Env;
  await new ConversationsRepo(new Db(d1)).getOrCreate("whatsapp", "50760000000", "Pilar");
  await guardarClic(env, CONV, { ctwaClid: "CLID-1", wabaId: "WABA7" });
  originalFetch = globalThis.fetch;
  eventos = [];
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).endsWith("/dataset")) return Response.json({ data: [{ dataset_id: "DS1" }] });
    eventos.push(JSON.parse(String(init?.body)));
    return Response.json({ events_received: 1 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};

describe("marcar un lead como vendido", () => {
  it("con monto, le avisa a Meta la compra", async () => {
    const id = await new LeadsRepo(new Db(env.DB)).create({ conversationId: CONV, channelUserId: null, intent: "Start" });
    const res = await adminApp.request(`/leads/${id}/status`, { method: "POST", headers: AUTH, body: form({ status: "sold", monto: "$295" }) }, env);
    expect(res.status).toBe(302);
    expect(eventos[0].data[0]).toMatchObject({ event_name: "Purchase", custom_data: { currency: "USD", value: 295 } });
  });

  it("«$1,200» llega a Meta como 1200", async () => {
    const id = await new LeadsRepo(new Db(env.DB)).create({ conversationId: CONV, channelUserId: null, intent: "Pro" });
    await adminApp.request(`/leads/${id}/status`, { method: "POST", headers: AUTH, body: form({ status: "sold", monto: "$1,200" }) }, env);
    expect(eventos[0].data[0].custom_data.value).toBe(1200);
  });

  it("los otros estados no le dicen nada a Meta", async () => {
    const id = await new LeadsRepo(new Db(env.DB)).create({ conversationId: CONV, channelUserId: null, intent: "Start" });
    await adminApp.request(`/leads/${id}/status`, { method: "POST", headers: AUTH, body: form({ status: "contacted" }) }, env);
    expect(eventos).toHaveLength(0);
  });

  it("la lista de leads pregunta el monto al elegir «Vendido»", async () => {
    await new LeadsRepo(new Db(env.DB)).create({ conversationId: CONV, channelUserId: null, intent: "Start" });
    const html = await (await adminApp.request("/leads", { headers: AUTH }, env)).text();
    expect(html).toContain("¿Por cuánto se vendió?");
    expect(html).toContain('name="monto"');
  });
});

describe("Configuración → Publicidad en Meta", () => {
  it("enseña cuántos llegaron por un anuncio y qué se avisó", async () => {
    const html = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    expect(html).toContain("Publicidad en Meta: conversiones");
    expect(html).toContain("WABA7");
    expect(html).toContain("Mandar evento de prueba");
  });

  it("el botón de prueba manda un lead con el código de prueba y el último clic", async () => {
    const res = await adminApp.request("/meta/probar", { method: "POST", headers: AUTH, body: form({ meta_codigo_prueba: "TEST99" }) }, env);
    expect(res.status).toBe(302);
    expect(eventos[0]).toMatchObject({ test_event_code: "TEST99", data: [{ event_name: "LeadSubmitted", user_data: { ctwa_clid: "CLID-1" } }] });
    const html = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    expect(html).toContain("Evento de prueba recibido por Meta.");
  });

  it("sin código de prueba, lo pide y no manda nada", async () => {
    await adminApp.request("/meta/probar", { method: "POST", headers: AUTH, body: form({}) }, env);
    expect(eventos).toHaveLength(0);
    const html = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    expect(html).toContain("Pega primero el código de prueba");
  });
});

// Auditoría de Meta Ads (1-nov-2026): una fila por anuncio, para decidir cada
// lunes cuál se pausa. Cuenta también las conversaciones de antes de guardar el
// clic (solo con la marca [ANUNCIO: …] o el mensaje automático).
describe("cómo rinde cada anuncio", () => {
  const MARCA = (t: string) => `[ANUNCIO: llegó desde un anuncio de Meta: «${t}» · «Texto del anuncio»]`;
  const APERTURA = "Hola, vi el anuncio de la página web. Quiero información.";

  async function conv(tel: string, mensajes: string[], metadata?: object, desde = Date.now() - 60_000) {
    const db = new Db(env.DB);
    const c = await new ConversationsRepo(db).getOrCreate("whatsapp", tel, tel);
    if (metadata) await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify(metadata), c.id]);
    let t = desde;
    for (const m of mensajes) {
      await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)", [
        crypto.randomUUID(),
        c.id,
        m,
        t++,
      ]);
    }
    return c.id;
  }

  it("agrupa por id del anuncio o por titular, y cuenta quién contestó, no clientes, leads y ventas", async () => {
    // El clic de beforeEach (CONV): llegó por el anuncio AD1 y contestó.
    await new Db(env.DB).run("UPDATE conversations SET metadata = ? WHERE id = ?", [
      JSON.stringify({ anuncio: { ctwa_clid: "CLID-1", source_id: "AD1", titular: "Tu página en días", at: Date.now() - 10_000 } }),
      CONV,
    ]);
    await new Db(env.DB).run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m0', ?, 'user', ?, ?)", [
      CONV,
      `${APERTURA}\n${MARCA("Tu página en días")}`,
      Date.now() - 5000,
    ]);
    await new Db(env.DB).run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', ?, 'user', 'Es para mi barbería', ?)", [
      CONV,
      Date.now() - 4000,
    ]);
    const lead = await new LeadsRepo(new Db(env.DB)).create({ conversationId: CONV, channelUserId: null, intent: "Start" });
    await new LeadsRepo(new Db(env.DB)).setStatus(lead, "sold");

    // Antes de guardar el clic: solo la marca, con titular.
    await conv("50761000001", [`${APERTURA}\n${MARCA("A tu nombre")}`]);
    await conv("50761000002", [`${APERTURA}\n${MARCA("A tu nombre")}`, "Quiero prestamo de 2000"], {
      no_cliente: { motivo: "prestamo", at: 1 },
    });
    const conLead = await conv("50761000003", [`${APERTURA}\n${MARCA("A tu nombre")}`, "Busco empleo"], {
      no_cliente: { motivo: "empleo", at: 1 },
    });
    // Un lead de quien no es cliente no cuenta como lead.
    await new LeadsRepo(new Db(env.DB)).create({ conversationId: conLead, channelUserId: null, intent: "Busca empleo" });
    // Más vieja todavía: solo el mensaje automático.
    await conv("50761000004", [APERTURA]);
    // No vino de un anuncio: no sale.
    await conv("50761000005", ["Hola, ¿hacen tiendas en línea?"]);

    const html = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    expect(html).toContain("Cómo rinde cada anuncio");
    const filas = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const fila = (t: string) => filas.find((f) => f.includes(t))!;
    // titular · llegaron · contestaron (%) · no clientes (y por qué) · leads · ventas
    expect(fila("A tu nombre")).toBe("A tu nombre 3 2 (67 %) 2 1 busca un préstamo · 1 busca empleo 0 0");
    expect(fila("Tu página en días")).toBe("Tu página en días id AD1 1 1 (100 %) 0 1 1");
    expect(fila("Anuncio sin identificar")).toBe("Anuncio sin identificar 1 0 (0 %) 0 0 0");
    expect(html).not.toContain("50761000005");
    // En el teléfono es una tarjeta por fila (§7f).
    expect(html).toContain('class="tablecards"');
    expect(html).toContain('data-label="Contestaron"');
  });

  it("7 días por defecto, y 30 a un toque", async () => {
    // Llegó por el anuncio hace 10 días y volvió a escribir hoy.
    const vieja = await conv("50761000009", [`${APERTURA}\n${MARCA("Viejo")}`], undefined, Date.now() - 10 * 24 * 3600_000);
    await new Db(env.DB).run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('hoy', ?, 'user', 'Hola de nuevo', ?)", [
      vieja,
      Date.now() - 1000,
    ]);
    const siete = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    expect(siete).not.toContain("Viejo");
    expect(siete).toContain('href="/admin/config?anuncios=30#meta"');
    const treinta = await (await adminApp.request("/config?anuncios=30", { headers: AUTH }, env)).text();
    expect(treinta).toContain("Viejo");
  });
});

// Hallazgo de Codex: quien escribió hace meses y vuelve por un anuncio cuenta
// para ese anuncio, sin que se le apunte lo que contestó o compró antes.
describe("quien vuelve por un anuncio", () => {
  it("cuenta desde el clic", async () => {
    const db = new Db(env.DB);
    const hace = (dias: number) => Date.now() - dias * 24 * 3600_000;
    await db.run("UPDATE conversations SET started_at = ?, metadata = ? WHERE id = ?", [
      hace(90),
      JSON.stringify({ anuncio: { ctwa_clid: "CLID-1", source_id: "AD7", titular: "Volvió", at: hace(1) } }),
      CONV,
    ]);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('a', ?, 'user', 'Quiero una tienda en línea', ?)", [CONV, hace(90)]);
    const viejo = await new LeadsRepo(db).create({ conversationId: CONV, channelUserId: null, intent: "Tienda" });
    await db.run("UPDATE leads SET status = 'sold', created_at = ? WHERE id = ?", [hace(80), viejo]);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('b', ?, 'user', ?, ?)", [
      CONV,
      "Hola, vi el anuncio de la página web. Quiero información.\n[ANUNCIO: llegó desde un anuncio de Meta: «Volvió»]",
      hace(1) + 1000,
    ]);
    const html = await (await adminApp.request("/config", { headers: AUTH }, env)).text();
    const filas = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    // Llegó 1; no contestó a ESTE anuncio; ni el lead ni la venta de hace meses cuentan.
    expect(filas.find((f) => f.includes("Volvió"))).toBe("Volvió id AD7 1 0 (0 %) 0 0 0");
  });
});

describe("«No es cliente» en la conversación", () => {
  it("se marca y se quita desde el panel, y se ve en la lista", async () => {
    const url = `/conversations/${encodeURIComponent(CONV)}/cliente`;
    let html = await (await adminApp.request(url, { method: "POST", headers: { ...AUTH, "HX-Request": "true" }, body: form({ es: "0" }) }, env)).text();
    expect(html).toContain("No es cliente · Marcado por usted");
    expect(html).toContain("Sí es cliente");
    const lista = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(lista).toMatch(/>No es cliente</);

    html = await (await adminApp.request(url, { method: "POST", headers: { ...AUTH, "HX-Request": "true" }, body: form({ es: "1" }) }, env)).text();
    expect(html).not.toContain("No es cliente ·");
    const meta = JSON.parse(
      (await env.DB.prepare("SELECT metadata FROM conversations WHERE id = ?").bind(CONV).first<{ metadata: string }>())!.metadata,
    );
    // El clic del anuncio sigue ahí, y el detector ya no la toca.
    expect(meta).toMatchObject({ anuncio: { ctwa_clid: "CLID-1" }, no_cliente_revisado: true });
    expect(meta.no_cliente).toBeUndefined();
  });

  it("sin htmx vuelve a la conversación", async () => {
    const res = await adminApp.request(`/conversations/${encodeURIComponent(CONV)}/cliente`, { method: "POST", headers: AUTH, body: form({ es: "0" }) }, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/admin/conversations?c=${encodeURIComponent(CONV)}`);
  });
});
