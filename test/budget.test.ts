/**
 * Tests for the monthly AI budget guard: month-to-date cost aggregation and
 * the pure downgrade decision the agent applies.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { recordAiUsage } from "../src/db/aiUsage";
import { monthIaCostUsd, monthStartMs, applyBudgetGuard } from "../src/budget";

describe("applyBudgetGuard", () => {
  it("does nothing without a budget", () => {
    expect(applyBudgetGuard("smart", 999, undefined)).toEqual({ tier: "smart", downgraded: false });
  });

  it("keeps the tier below the budget", () => {
    expect(applyBudgetGuard("smart", 4.99, 5)).toEqual({ tier: "smart", downgraded: false });
  });

  it("downgrades to fast at/over the budget", () => {
    expect(applyBudgetGuard("smart", 5, 5)).toEqual({ tier: "fast", downgraded: true });
    expect(applyBudgetGuard("smart", 7.2, 5)).toEqual({ tier: "fast", downgraded: true });
  });

  it("fast tier is never 'downgraded'", () => {
    expect(applyBudgetGuard("fast", 99, 5)).toEqual({ tier: "fast", downgraded: false });
  });
});

describe("monthIaCostUsd", () => {
  let db: Db;
  let convs: ConversationsRepo;

  const usage = { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 50_000 };

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    db = new Db((await mf.getD1Database("DB")) as any);
    convs = new ConversationsRepo(db);
  });

  it("sums only usage from the current month", async () => {
    const conv = await convs.getOrCreate("telegram", "u1");
    await recordAiUsage(db, {
      source: "chat",
      conversationId: conv.id,
      model: "claude-haiku-4-5-20251001",
      usage,
    });
    const inMonth = await monthIaCostUsd(db);
    expect(inMonth).toBeGreaterThan(0);

    // Usage from before the month start must not change the total.
    await recordAiUsage(db, {
      source: "chat",
      conversationId: conv.id,
      model: "claude-haiku-4-5-20251001",
      usage,
      createdAt: monthStartMs() - 1000,
    });
    expect(await monthIaCostUsd(db)).toBeCloseTo(inMonth, 10);
  });

  it("counts the automated jobs, not just the chats", async () => {
    await recordAiUsage(db, {
      source: "chat",
      conversationId: "telegram:u1",
      model: "claude-haiku-4-5-20251001",
      usage,
    });
    const chatOnly = await monthIaCostUsd(db);

    // El analista nocturno gasta con la MISMA llave: tiene que sumar al tope.
    await recordAiUsage(db, {
      source: "insights",
      model: "claude-haiku-4-5-20251001",
      usage,
    });
    expect(await monthIaCostUsd(db)).toBeCloseTo(chatOnly * 2, 10);
  });

  it("charges cache writes more than cache reads", async () => {
    await recordAiUsage(db, {
      id: "read",
      source: "chat",
      model: "claude-haiku-4-5-20251001",
      usage: { input: 100_000, cacheRead: 100_000, cacheWrite: 0, output: 0 },
    });
    const readOnly = await monthIaCostUsd(db);

    const mf2 = await createTestMiniflare();
    const db2 = new Db((await mf2.getD1Database("DB")) as any);
    await recordAiUsage(db2, {
      id: "write",
      source: "chat",
      model: "claude-haiku-4-5-20251001",
      usage: { input: 100_000, cacheRead: 0, cacheWrite: 100_000, output: 0 },
    });
    expect(await monthIaCostUsd(db2)).toBeGreaterThan(readOnly);
  });

  it("returns 0 with no usage", async () => {
    expect(await monthIaCostUsd(db)).toBe(0);
  });
});
