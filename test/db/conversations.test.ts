import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { LeadsRepo } from "../../src/db/leads";
import { recordAiUsage, usageCostSince } from "../../src/db/aiUsage";

let db: Db;
let repo: ConversationsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  repo = new ConversationsRepo(db);
});

describe("ConversationsRepo", () => {
  it("getOrCreate inserts a row on first call and returns existing on repeat", async () => {
    const conv1 = await repo.getOrCreate("telegram", "user_123", "María");
    const conv2 = await repo.getOrCreate("telegram", "user_123", "María");
    expect(conv1.id).toBe(conv2.id);
    expect(conv1.channel).toBe("telegram");
    expect(conv1.display_name).toBe("María");
  });

  it("setPausedUntil updates the column", async () => {
    const conv = await repo.getOrCreate("telegram", "user_456");
    const until = Date.now() + 3_600_000;
    await repo.setPausedUntil(conv.id, until);
    const fresh = await repo.getById(conv.id);
    expect(fresh?.paused_until).toBe(until);
  });

  it("isPaused returns true when paused_until is in the future", async () => {
    const conv = await repo.getOrCreate("telegram", "user_789");
    await repo.setPausedUntil(conv.id, Date.now() + 60_000);
    expect(await repo.isPaused(conv.id)).toBe(true);
  });

  it("isPaused returns false when paused_until is past", async () => {
    const conv = await repo.getOrCreate("telegram", "user_999");
    await repo.setPausedUntil(conv.id, Date.now() - 60_000);
    expect(await repo.isPaused(conv.id)).toBe(false);
  });

  describe("delete", () => {
    it("borra la conversación y todo lo que cuelga de ella", async () => {
      const conv = await repo.getOrCreate("telegram", "borrar_1", "Ana");
      await new MessagesRepo(db).append(conv.id, "user", "hola");
      await db.run(
        "INSERT INTO customer_facts (conversation_id, fact, learned_at) VALUES (?, ?, ?)",
        [conv.id, "prefiere efectivo", Date.now()],
      );
      await db.run(
        "INSERT INTO conv_labels (conversation_id, interest, labeled_at) VALUES (?, ?, ?)",
        [conv.id, "alto", Date.now()],
      );
      await db.run(
        "INSERT INTO followup_sends (conversation_id, reason, sent_at) VALUES (?, ?, ?)",
        [conv.id, "venta_abierta", Date.now()],
      );

      expect(await repo.delete(conv.id)).toBe(true);
      expect(await repo.getById(conv.id)).toBeNull();
      for (const table of ["messages", "customer_facts", "conv_labels", "followup_sends"]) {
        const left = await db.first<{ n: number }>(
          `SELECT COUNT(*) as n FROM ${table} WHERE conversation_id = ?`,
          [conv.id],
        );
        expect(left).toEqual({ n: 0 });
      }
    });

    it("conserva el lead capturado, solo le suelta el vínculo", async () => {
      const conv = await repo.getOrCreate("whatsapp", "borrar_2");
      await new LeadsRepo(db).create({
        conversationId: conv.id,
        channelUserId: "borrar_2",
        name: "Ana",
        intent: "compra",
      });

      await repo.delete(conv.id);

      const lead = await db.first<{ name: string; conversation_id: string | null }>(
        "SELECT name, conversation_id FROM leads WHERE name = ?",
        ["Ana"],
      );
      expect(lead?.name).toBe("Ana");
      expect(lead?.conversation_id).toBeNull();
    });

    it("no borra el gasto de IA ya facturado", async () => {
      const conv = await repo.getOrCreate("telegram", "borrar_3");
      await recordAiUsage(db, {
        source: "chat",
        conversationId: conv.id,
        model: "claude-haiku-4-5-20251001",
        usage: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      });
      const before = await usageCostSince(db, 0);

      await repo.delete(conv.id);

      expect(await usageCostSince(db, 0)).toBeCloseTo(before, 10);
    });

    it("devuelve false si la conversación no existe", async () => {
      expect(await repo.delete("telegram:fantasma")).toBe(false);
    });
  });
});
