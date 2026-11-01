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
