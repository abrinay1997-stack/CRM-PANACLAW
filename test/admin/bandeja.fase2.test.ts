/**
 * Fase 2 de la bandeja (7-nov-2026), sin migración: sin leer, esperan respuesta,
 * respuestas rápidas, cabeceras de día, reenviados y las fotos de Twilio.
 * D1 real vía miniflare, como en inbox.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { marcarLeida, SQL_SIN_LEER, SQL_ESPERAN, esperaLegible } from "../../src/bandeja";
import { guardarRespuesta, leerRespuestas, borrarRespuesta, limpiarAtajo } from "../../src/respuestasRapidas";
import { etiquetaDeDia, mismoDia, mensajeParaVer, cuerpoDelMensaje } from "../../src/admin/views/mensajes";
import { parseWhatsAppEvents } from "../../src/channels/whatsapp";
import { bytesDeMedia } from "../../src/media/almacen";
import { paraElModelo } from "../../src/agent";
import type { Env } from "../../src/env";

const AUTH = { Authorization: `Basic ${btoa("admin:secret123")}` };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BOT_TIERS: "pro", BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123", BOT_TIMEZONE: "America/Panama" } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
});

afterEach(() => vi.restoreAllMocks());

const sinLeer = async (id: string) =>
  !!(await db.first(`SELECT 1 x FROM conversations c WHERE c.id = ? AND ${SQL_SIN_LEER}`, [id]));
const esperan = async (id: string) =>
  !!(await db.first(`SELECT 1 x FROM conversations c WHERE c.id = ? AND ${SQL_ESPERAN}`, [id, Date.now()]));

describe("sin leer", () => {
  it("lo que escribe el cliente queda sin leer hasta que alguien abre la conversación", async () => {
    const c = await convs.getOrCreate("whatsapp", "507600", "Ana");
    expect(await sinLeer(c.id)).toBe(false);
    await msgs.append(c.id, "user", "hola", { createdAt: Date.now() - 1000 });
    expect(await sinLeer(c.id)).toBe(true);
    await marcarLeida(db, c.id);
    expect(await sinLeer(c.id)).toBe(false);
    await msgs.append(c.id, "user", "¿sigues ahí?", { createdAt: Date.now() + 5 });
    expect(await sinLeer(c.id)).toBe(true);
  });

  it("lo que dice el bot o el equipo no cuenta como sin leer", async () => {
    const c = await convs.getOrCreate("whatsapp", "507601", "Luis");
    await msgs.append(c.id, "assistant", "Hola, ¿en qué te ayudo?");
    expect(await sinLeer(c.id)).toBe(false);
  });

  it("un metadata roto no tumba la consulta", async () => {
    const c = await convs.getOrCreate("whatsapp", "507602", "Rota");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", ["{esto no es json", c.id]);
    await msgs.append(c.id, "user", "hola");
    expect(await sinLeer(c.id)).toBe(true);
  });

  it("abrir la conversación en el panel la marca leída y conserva el resto del metadata", async () => {
    const c = await convs.getOrCreate("whatsapp", "507603", "María");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify({ sin_seguimiento: true }), c.id]);
    await msgs.append(c.id, "user", "hola");
    const res = await adminApp.request(`/conversations?c=${encodeURIComponent(c.id)}`, { headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(await sinLeer(c.id)).toBe(false);
    const fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [c.id]);
    expect(JSON.parse(fila!.metadata)).toMatchObject({ sin_seguimiento: true });
  });

  it("la lista marca con punto las que tienen mensajes sin leer y el filtro las separa", async () => {
    const a = await convs.getOrCreate("whatsapp", "1", "Con mensaje");
    const b = await convs.getOrCreate("whatsapp", "2", "Ya leída");
    await msgs.append(a.id, "user", "hola");
    await msgs.append(b.id, "user", "hola");
    await marcarLeida(db, b.id);
    const res = await adminApp.request("/conversations?f=sinleer", { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain("Con mensaje");
    expect(html).not.toContain("Ya leída");
    expect(html).toContain('aria-label="Mensajes sin leer"');
  });
});

describe("esperan respuesta", () => {
  it("solo cuenta la que tiene una persona encima y cuyo último mensaje es del cliente", async () => {
    const c = await convs.getOrCreate("whatsapp", "10", "Pau");
    await msgs.append(c.id, "user", "necesito ayuda");
    expect(await esperan(c.id)).toBe(false); // la atiende el bot
    await convs.setPausedUntil(c.id, Date.now() + 3_600_000);
    expect(await esperan(c.id)).toBe(true);
    await msgs.append(c.id, "owner", "ya te ayudo", { createdAt: Date.now() + 10 });
    expect(await esperan(c.id)).toBe(false); // ya contestaron
  });

  it("la espera se dice en palabras", () => {
    const ahora = 10_000_000;
    expect(esperaLegible(ahora - 30_000, ahora)).toBe("ahora");
    expect(esperaLegible(ahora - 5 * 60_000, ahora)).toBe("5 min");
    expect(esperaLegible(ahora - 3 * 3_600_000, ahora)).toBe("3 h");
    expect(esperaLegible(ahora - 72 * 3_600_000, ahora)).toBe("3 d");
  });
});

describe("respuestas rápidas", () => {
  it("el atajo se limpia: minúsculas, sin acentos ni «/»", () => {
    expect(limpiarAtajo("/Horario Atención")).toBe("horario-atencion");
  });

  it("se guardan, se reemplazan por el mismo atajo y se borran", async () => {
    expect(await guardarRespuesta(db, "horario", "Abrimos de 9 a 5")).toBeNull();
    expect(await guardarRespuesta(db, "/Horario", "Abrimos de 8 a 6")).toBeNull();
    expect(await leerRespuestas(db)).toEqual([{ atajo: "horario", texto: "Abrimos de 8 a 6" }]);
    await borrarRespuesta(db, "horario");
    expect(await leerRespuestas(db)).toEqual([]);
  });

  it("rechaza lo vacío y lo demasiado largo, diciendo por qué", async () => {
    expect(await guardarRespuesta(db, "", "x")).toMatch(/nombre corto/i);
    expect(await guardarRespuesta(db, "a", "  ")).toMatch(/texto/i);
    expect(await guardarRespuesta(db, "a", "x".repeat(1001))).toMatch(/1000/);
  });

  it("desde el panel: se añade, aparece en el composer y se borra", async () => {
    const c = await convs.getOrCreate("whatsapp", "20", "Carlos Pérez");
    const alta = await adminApp.request(
      "/respuestas-rapidas",
      { method: "POST", headers: FORM, body: new URLSearchParams({ atajo: "pago", texto: "Hola {nombre}, te paso los datos de pago" }) },
      env,
    );
    expect(await alta.text()).toContain("/pago");
    const pagina = await (await adminApp.request(`/conversations?c=${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(pagina).toContain('data-atajo="pago"');
    expect(pagina).toContain('data-nombre="Carlos"');
    const baja = await adminApp.request(
      "/respuestas-rapidas/borrar",
      { method: "POST", headers: FORM, body: new URLSearchParams({ atajo: "pago" }) },
      env,
    );
    expect(await baja.text()).not.toContain('data-atajo="pago"');
  });
});

describe("el hilo", () => {
  it("separa los días: Hoy, Ayer y la fecha", () => {
    const ahora = Date.UTC(2026, 10, 7, 18, 0); // 7-nov, 13:00 en Panamá
    expect(etiquetaDeDia(env, ahora, ahora)).toBe("Hoy");
    expect(etiquetaDeDia(env, ahora - 86_400_000, ahora)).toBe("Ayer");
    expect(etiquetaDeDia(env, ahora - 5 * 86_400_000, ahora)).toMatch(/2 nov/);
    expect(mismoDia(env, ahora, ahora - 3_600_000)).toBe(true);
    expect(mismoDia(env, ahora, ahora - 86_400_000)).toBe(false);
  });

  it("el día se cuenta en la hora del negocio, no en UTC", () => {
    // 02:00 UTC del 8 es todavía el 7 por la noche en Panamá (UTC−5).
    const a = Date.UTC(2026, 10, 8, 2, 0);
    const b = Date.UTC(2026, 10, 7, 20, 0);
    expect(mismoDia(env, a, b)).toBe(true);
  });

  it("el hilo trae una cabecera por día", async () => {
    const c = await convs.getOrCreate("whatsapp", "30", "Días");
    const ahora = Date.now();
    await msgs.append(c.id, "user", "ayer escribí", { createdAt: ahora - 2 * 86_400_000 });
    await msgs.append(c.id, "user", "hoy escribo", { createdAt: ahora });
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(html).toContain("Hoy");
  });
});

describe("mensajes reenviados", () => {
  const cuerpo = (m: any) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value: { messages: [m], contacts: [] } }] }],
  });

  it("WhatsApp los marca y el panel lo dice", async () => {
    const out = await parseWhatsAppEvents(
      cuerpo({ from: "1", id: "a", type: "text", text: { body: "mira esto" }, context: { forwarded: true } }) as any,
      { WHATSAPP_APP_SECRET: "x" } as any,
      "https://bot.test",
    );
    expect(out[0].text).toBe("[REENVIADO] mira esto");
    const vista = mensajeParaVer(out[0].text!);
    expect(vista.reenviado).toBe(true);
    expect(vista.texto).toBe("mira esto");
    expect(cuerpoDelMensaje(out[0].text!, new Map())).toContain("Reenviado");
  });

  it("al modelo se le dice que no lo escribió el cliente", () => {
    expect(paraElModelo("[REENVIADO] oferta 2x1")).toContain("no lo escribió él");
  });

  it("un mensaje normal no se marca", async () => {
    const out = await parseWhatsAppEvents(
      cuerpo({ from: "1", id: "b", type: "text", text: { body: "hola" } }) as any,
      { WHATSAPP_APP_SECRET: "x" } as any,
      "https://bot.test",
    );
    expect(out[0].text).toBe("hola");
  });
});

describe("fotos de Twilio", () => {
  it("se piden con la cuenta y el token de Twilio; las de otros sitios, sin ellos", async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", f);
    const e = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" } as any;
    await bytesDeMedia(e, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1");
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe(`Basic ${btoa("AC1:tok")}`);
    await bytesDeMedia(e, "https://example.com/foto.jpg");
    expect((f.mock.calls[1] as any)[1]).toBeUndefined();
  });
});

describe("formato de WhatsApp en el hilo", () => {
  it("negrita, cursiva, tachado y enlaces como los ve el cliente", async () => {
    const { conFormatoDeWhatsApp } = await import("../../src/admin/views/mensajes");
    expect(conFormatoDeWhatsApp("es *PanaClaw Start*: *$295*")).toBe("es <b>PanaClaw Start</b>: <b>$295</b>");
    expect(conFormatoDeWhatsApp("_hola_ y ~no~")).toBe("<i>hola</i> y <s>no</s>");
    const enlace = conFormatoDeWhatsApp("mira https://panaclaw.com/web_nueva_ya.");
    expect(enlace).toContain('<a href="https://panaclaw.com/web_nueva_ya"');
    expect(enlace).not.toContain("<i>");
  });

  it("no se come asteriscos sueltos ni abre la puerta a etiquetas", async () => {
    const { conFormatoDeWhatsApp, cuerpoDelMensaje } = await import("../../src/admin/views/mensajes");
    expect(conFormatoDeWhatsApp("2 * 3 * 4")).toBe("2 * 3 * 4");
    // El texto se escapa antes: lo que parezca HTML sigue siendo texto.
    const html = cuerpoDelMensaje('<img src=x onerror=alert(1)> *ok*', new Map());
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<b>ok</b>");
  });
});

describe("marcar leídas", () => {
  it("deja todas leídas de una vez y conserva el resto del metadata", async () => {
    const { marcarTodasLeidas } = await import("../../src/bandeja");
    const a = await convs.getOrCreate("whatsapp", "70", "A");
    const b = await convs.getOrCreate("whatsapp", "71", "B");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify({ sin_seguimiento: true }), a.id]);
    await msgs.append(a.id, "user", "hola");
    await msgs.append(b.id, "user", "hola");
    expect(await sinLeer(a.id)).toBe(true);
    expect(await marcarTodasLeidas(db)).toBe(2);
    expect(await sinLeer(a.id)).toBe(false);
    expect(await sinLeer(b.id)).toBe(false);
    const fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [a.id]);
    expect(JSON.parse(fila!.metadata)).toMatchObject({ sin_seguimiento: true });
  });

  it("desde el panel: el botón sale si hay algo sin leer y la ruta redirige", async () => {
    const c = await convs.getOrCreate("whatsapp", "72", "C");
    await msgs.append(c.id, "user", "hola");
    const pagina = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(pagina).toContain("Marcar leídas");
    const r = await adminApp.request("/conversations/marcar-leidas", { method: "POST", headers: AUTH }, env);
    expect(r.status).toBe(303);
    expect(await sinLeer(c.id)).toBe(false);
    const despues = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(despues).not.toContain("Marcar leídas");
  });
});
