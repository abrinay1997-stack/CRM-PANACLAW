/**
 * Pestaña Costos: lo que se prueba es que la cifra del panel incluya TODO el
 * gasto de IA — no solo los chats — porque ese fue justo el error que hacía que
 * el panel marcara menos que la factura del proveedor.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { recordAiUsage } from "../../src/db/aiUsage";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}`,
};

let env: Env;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "TestBot",
    BUSINESS_NAME: "Negocio de Prueba",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  db = new Db(d1);
});

describe("pestaña Costos", () => {
  it("renderiza sin gasto todavía", async () => {
    const res = await adminApp.request("/costs", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Total este mes");
    expect(html).toContain("$0.00");
  });

  it("suma los trabajos automáticos, no solo los chats", async () => {
    const million = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    await recordAiUsage(db, {
      source: "chat",
      conversationId: "telegram:u1",
      model: "claude-haiku-4-5-20251001",
      usage: million,
    });
    await recordAiUsage(db, {
      source: "insights",
      model: "claude-haiku-4-5-20251001",
      usage: million,
    });

    const html = await (await adminApp.request("/costs", { headers: AUTH }, env)).text();
    // 2M tokens de entrada de Haiku 4.5 a $1.00 el millón.
    expect(html).toContain("$2.00");
    expect(html).toContain("IA por origen");
    expect(html).toContain("Analista de insights");
    expect(html).toContain("Conversaciones");
  });

  it("muestra el detalle de caché leída vs escrita", async () => {
    await recordAiUsage(db, {
      source: "chat",
      model: "claude-haiku-4-5-20251001",
      usage: { input: 30_000, cacheRead: 10_000, cacheWrite: 20_000, output: 100 },
    });
    const html = await (await adminApp.request("/costs", { headers: AUTH }, env)).text();
    expect(html).toContain("10k tokens se leyeron del caché");
    expect(html).toContain("20k se escribieron");
  });
});
