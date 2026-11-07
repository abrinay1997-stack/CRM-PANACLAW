/**
 * Mandarle un archivo al cliente desde el panel (28-oct-2026), como en D'Casa.
 * D1 real (miniflare), R2 en memoria, y la red de Meta y Telegram de mentira.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };

let env: Env;
let originalFetch: typeof globalThis.fetch;
let llamadas: { url: string; init?: RequestInit }[];

function r2() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get() {
      return null;
    },
    async delete() {},
  };
}

function subida(nombre: string, mime: string, leyenda = "") {
  const form = new FormData();
  form.append("archivo", new File([new Uint8Array([37, 80, 68, 70, 1, 2])], nombre, { type: mime }));
  if (leyenda) form.append("leyenda", leyenda);
  return form;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    CATALOG: r2(),
    BOT_NAME: "PanaClaw",
    BUSINESS_NAME: "PanaClaw",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
    WHATSAPP_PHONE_NUMBER_ID: "PHONE1",
    WHATSAPP_ACCESS_TOKEN: "tok",
    TELEGRAM_BOT_TOKEN: "tg-tok",
  } as unknown as Env;
  const convs = new ConversationsRepo(new Db(d1));
  await convs.getOrCreate("whatsapp", "50760000000", "Cliente WA");
  await convs.getOrCreate("telegram", "777", "Cliente TG");
  await convs.getOrCreate("instagram", "ig_1", "Cliente IG");
  originalFetch = globalThis.fetch;
  llamadas = [];
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    llamadas.push({ url: String(url), init });
    if (String(url).endsWith("/media")) return Response.json({ id: "MEDIA1" });
    if (String(url).includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 5 } });
    return Response.json({ messages: [{ id: "wamid.1" }] });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const enviar = (conv: string, form: FormData) =>
  adminApp.request(`/conversations/${encodeURIComponent(conv)}/archivo`, { method: "POST", headers: AUTH, body: form }, env);

describe("POST /admin/conversations/:id/archivo", () => {
  it("por WhatsApp: sube a Meta, lo manda como documento con su nombre y queda en el hilo", async () => {
    const res = await enviar("whatsapp:50760000000", subida("cotizacion.pdf", "application/pdf", "Aquí va tu cotización"));
    const html = await res.text();
    expect(html).toContain("✓ Archivo enviado por WhatsApp");
    expect(res.headers.get("X-Sent")).toBe("1");

    expect(llamadas[0].url).toBe("https://graph.facebook.com/v26.0/PHONE1/media");
    const envio = JSON.parse(String(llamadas[1].init?.body));
    expect(envio).toMatchObject({
      to: "50760000000",
      type: "document",
      document: { id: "MEDIA1", filename: "cotizacion.pdf", caption: "Aquí va tu cotización" },
    });

    const fila = await env.DB.prepare("SELECT role, content FROM messages WHERE conversation_id = ?")
      .bind("whatsapp:50760000000")
      .first<{ role: string; content: string }>();
    expect(fila?.role).toBe("owner");
    expect(fila?.content).toMatch(/^Aquí va tu cotización\n\(le mandamos: cotizacion\.pdf\)\n\[ADJUNTO: [a-f0-9]{32}\]\n\[WAID: wamid\.1\]$/);
    // El hilo enseña el documento, no la marca ni el «(le mandamos: …)».
    expect(html).toContain("cotizacion.pdf");
    expect(html).not.toContain("(le mandamos:");
    // Como responder desde el panel: el bot se calla aquí.
    const conv = await env.DB.prepare("SELECT paused_until FROM conversations WHERE id = ?")
      .bind("whatsapp:50760000000")
      .first<{ paused_until: number | null }>();
    expect(conv?.paused_until ?? 0).toBeGreaterThan(Date.now());
  });

  it("si no se pudo guardar el archivo, el hilo igual dice qué se mandó", async () => {
    (env as any).CATALOG = { put: async () => { throw new Error("R2 caído"); } };
    const html = await (await enviar("whatsapp:50760000000", subida("cotizacion.pdf", "application/pdf"))).text();
    expect(html).toContain("✓ Archivo enviado por WhatsApp");
    expect(html).toContain("le mandamos: cotizacion.pdf");
    const texto = await (
      await adminApp.request(`/conversations/${encodeURIComponent("whatsapp:50760000000")}/texto`, { headers: AUTH }, env)
    ).text();
    expect(texto).toContain("Equipo: (le mandamos: cotizacion.pdf)");
  });

  it("una foto sale como foto", async () => {
    await enviar("whatsapp:50760000000", subida("local.jpg", "image/jpeg"));
    expect(JSON.parse(String(llamadas[1].init?.body)).type).toBe("image");
  });

  it("por Telegram: sendDocument al chat del cliente", async () => {
    const res = await enviar("telegram:777", subida("menu.pdf", "application/pdf"));
    expect(await res.text()).toContain("✓ Archivo enviado por Telegram");
    expect(llamadas[0].url).toBe("https://api.telegram.org/bottg-tok/sendDocument");
  });

  it("si WhatsApp lo rechaza, lo dice claro y no se guarda nada", async () => {
    globalThis.fetch = vi.fn(async (url: any) =>
      String(url).endsWith("/media")
        ? Response.json({ id: "MEDIA1" })
        : Response.json({ error: { message: "Re-engagement message: more than 24 hours" } }, { status: 400 }),
    ) as any;
    const html = await (await enviar("whatsapp:50760000000", subida("a.pdf", "application/pdf"))).text();
    expect(html).toContain("Pasaron más de 24 horas");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("un canal sin archivos lo dice, y el panel no enseña el botón", async () => {
    const html = await (await enviar("instagram:ig_1", subida("a.pdf", "application/pdf"))).text();
    expect(html).toContain("Este canal todavía no acepta archivos desde el panel.");
    const pagina = await (await adminApp.request(`/conversations?c=${encodeURIComponent("instagram:ig_1")}`, { headers: AUTH }, env)).text();
    expect(pagina).not.toContain("Adjuntar archivo");
    const conWa = await (await adminApp.request(`/conversations?c=${encodeURIComponent("whatsapp:50760000000")}`, { headers: AUTH }, env)).text();
    expect(conWa).toContain("Adjuntar archivo");
  });

  it("sin archivo, lo pide", async () => {
    const html = await (await enviar("whatsapp:50760000000", new FormData())).text();
    expect(html).toContain("Elige un archivo primero.");
  });
});
