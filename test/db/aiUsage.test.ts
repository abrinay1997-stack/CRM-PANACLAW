/**
 * Libro de gasto de IA: es la fuente de verdad del panel de Costos y del tope
 * mensual, así que lo que se prueba aquí es que NADA facturado se quede fuera.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import {
  recordAiUsage,
  usageFromSdk,
  usageSince,
  usageCostSince,
  rowCost,
  detachConversation,
} from "../../src/db/aiUsage";

let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  db = new Db((await mf.getD1Database("DB")) as any);
});

describe("usageFromSdk", () => {
  it("separa lectura y escritura de caché", () => {
    expect(
      usageFromSdk({
        inputTokens: 12_000,
        outputTokens: 300,
        inputTokenDetails: {
          noCacheTokens: 2_000,
          cacheReadTokens: 4_000,
          cacheWriteTokens: 6_000,
        },
      }),
    ).toEqual({ input: 12_000, cacheRead: 4_000, cacheWrite: 6_000, output: 300 });
  });

  it("cae al campo viejo cachedInputTokens si no hay detalle", () => {
    expect(usageFromSdk({ inputTokens: 900, outputTokens: 10, cachedInputTokens: 400 })).toEqual({
      input: 900,
      cacheRead: 400,
      cacheWrite: 0,
      output: 10,
    });
  });

  it("no explota con un usage vacío", () => {
    expect(usageFromSdk(undefined)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });
});

describe("recordAiUsage", () => {
  const usage = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 100 };

  it("anota y agrupa por día, modelo y origen", async () => {
    await recordAiUsage(db, { source: "chat", conversationId: "telegram:u1", model: "m1", usage });
    await recordAiUsage(db, { source: "insights", model: "m1", usage });

    const rows = await usageSince(db, 0);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(["chat", "insights"]);
    expect(rows.every((r) => r.calls === 1 && r.input === 1_000)).toBe(true);
  });

  it("con el mismo id no cuenta dos veces (el backfill puede repetirse)", async () => {
    await recordAiUsage(db, { id: "msg-1", source: "chat", model: "m1", usage });
    await recordAiUsage(db, { id: "msg-1", source: "chat", model: "m1", usage });
    const rows = await usageSince(db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(1);
  });

  it("ignora llamadas sin tokens y nunca lanza", async () => {
    await recordAiUsage(db, {
      source: "chat",
      model: "m1",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    expect(await usageSince(db, 0)).toHaveLength(0);
  });

  it("respeta la ventana de tiempo", async () => {
    const old = Date.now() - 40 * 86_400_000;
    await recordAiUsage(db, { source: "chat", model: "m1", usage, createdAt: old });
    await recordAiUsage(db, { source: "chat", model: "m1", usage });
    expect(await usageSince(db, 0)).toHaveLength(2);
    expect(await usageSince(db, Date.now() - 30 * 86_400_000)).toHaveLength(1);
  });
});

describe("costo", () => {
  it("cobra la escritura de caché más cara que la lectura", () => {
    const base = { model: "claude-haiku-4-5-20251001", input: 100_000, output: 0 };
    const read = rowCost({ ...base, cacheRead: 100_000, cacheWrite: 0 });
    const write = rowCost({ ...base, cacheRead: 0, cacheWrite: 100_000 });
    const fresh = rowCost({ ...base, cacheRead: 0, cacheWrite: 0 });
    expect(read).toBeLessThan(fresh);
    expect(write).toBeGreaterThan(fresh);
  });

  it("suma el gasto de todos los orígenes", async () => {
    const usage = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    await recordAiUsage(db, { source: "chat", model: "claude-haiku-4-5-20251001", usage });
    await recordAiUsage(db, { source: "followup", model: "claude-haiku-4-5-20251001", usage });
    // 2M tokens de entrada de Haiku 4.5 a $1.00 el millón.
    expect(await usageCostSince(db, 0)).toBeCloseTo(2, 6);
  });
});

describe("detachConversation", () => {
  it("borra el vínculo pero conserva el gasto", async () => {
    await recordAiUsage(db, {
      source: "chat",
      conversationId: "telegram:u1",
      model: "m1",
      usage: { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 10 },
    });
    await detachConversation(db, "telegram:u1");
    const rows = await usageSince(db, 0);
    expect(rows).toHaveLength(1);
    expect(
      await db.first<{ n: number }>("SELECT COUNT(*) as n FROM ai_usage WHERE conversation_id IS NULL"),
    ).toEqual({ n: 1 });
  });
});

describe("backfill del esquema", () => {
  it("mete el histórico de `messages` al libro y no lo duplica al repetirse", async () => {
    const conv = "telegram:viejo";
    await db.run(
      "INSERT INTO conversations (id, channel, channel_user_id, started_at, last_message_at) VALUES (?, ?, ?, ?, ?)",
      [conv, "telegram", "viejo", Date.now(), Date.now()],
    );
    await db.run(
      `INSERT INTO messages (id, conversation_id, role, content, model_used,
                             input_tokens, output_tokens, cached_input_tokens, created_at)
       VALUES (?, ?, 'assistant', 'hola', ?, ?, ?, ?, ?)`,
      ["msg-viejo", conv, "claude-haiku-4-5-20251001", 5_000, 200, 1_000, Date.now()],
    );

    // El MISMO statement que se aplica en producción con `pnpm db:apply`.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(path.resolve(here, "../../src/db/schema.sql"), "utf-8");
    const backfill = schema
      .split(";")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((stmt) => stmt.startsWith("INSERT OR IGNORE INTO ai_usage"));
    expect(backfill).toBeTruthy();

    await db.run(backfill!);
    await db.run(backfill!); // re-aplicar el esquema no puede duplicar el gasto

    const rows = await usageSince(db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "chat", calls: 1, input: 5_000, cacheRead: 1_000, output: 200 });
  });
});
