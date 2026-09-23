import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { TicketsRepo } from "../../src/db/tickets";
import { ConversationsRepo } from "../../src/db/conversations";
import { pauseBotTool } from "../../src/tools/pauseBot";
import { handoffHumanTool } from "../../src/tools/handoffHuman";

/**
 * El bot dejó a un cliente esperando y nadie se enteró.
 *
 * Caso real: el cliente pidió "quiero hablar con una persona" y el modelo
 * eligió pauseBot —cuya descripción decía "el dueño humano tomará el
 * control"— en vez de handoffHuman. pauseBot solo escribía paused_until: sin
 * ticket, sin aviso, sin rastro. El cliente esperando y el dueño sin saberlo.
 *
 * Ahora las dos tools pasan por openTicketAndNotify, así que el aviso no
 * depende de cuál elija el modelo.
 */

let env: any;
let convId: string;
let tickets: TicketsRepo;
let convs: ConversationsRepo;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  tickets = new TicketsRepo(db);
  convs = new ConversationsRepo(db);
  convId = (await convs.getOrCreate("whatsapp", "+50760001111")).id;
  env = {
    DB: d1,
    BUSINESS_NAME: "PanaClaw",
    DASHBOARD_BASE_URL: "https://dash.test",
    BOT_TIER: "pro",
    TELEGRAM_BOT_TOKEN: "tok",
    OWNER_TELEGRAM_CHAT_ID: "996559980",
  };
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

afterEach(() => vi.restoreAllMocks());

// Los avisos que salieron (sendMessage). Antes del primero el bot también
// protege el webhook de la consola (getWebhookInfo/setWebhook): eso no es un aviso.
const telegramCalls = () =>
  fetchSpy.mock.calls.filter((c: unknown[]) => /api\.telegram\.org\/.*\/sendMessage$/.test(String(c[0])));

describe("pauseBot", () => {
  it("pausa la conversación Y abre ticket con aviso al dueño", async () => {
    const tool = pauseBotTool(env, () => convId);
    const res: any = await tool.execute!({ minutes: 60, reason: "Cliente solicita atención humana" }, {} as any);

    expect(res.pausedUntil).toBeGreaterThan(Date.now());
    expect(await convs.isPaused(convId)).toBe(true);

    const abiertos = await tickets.listOpen();
    expect(abiertos).toHaveLength(1);
    expect(abiertos[0].summary).toContain("Cliente solicita atención humana");

    expect(telegramCalls()).toHaveLength(1);
    const dm = JSON.parse(String((telegramCalls()[0][1] as RequestInit).body));
    expect(dm.chat_id).toBe("996559980");
    expect(dm.text).toContain("Cliente solicita atención humana");
  });

  it("sin reason explica igual por qué se pausó", async () => {
    const tool = pauseBotTool(env, () => convId);
    await tool.execute!({ minutes: 30 }, {} as any);
    expect((await tickets.listOpen())[0].summary).toContain("30 min");
  });

  it("deja el ticket ligado a la conversación para que el panel lo muestre", async () => {
    const tool = pauseBotTool(env, () => convId);
    const res: any = await tool.execute!({ minutes: 60 }, {} as any);
    expect((await convs.getById(convId))?.open_ticket_id).toBe(res.ticketId);
  });
});

describe("handoffHuman + pauseBot en el mismo turno", () => {
  it("no duplica ticket ni avisa dos veces (handoff primero)", async () => {
    const handoff = handoffHumanTool(env, () => convId);
    const pause = pauseBotTool(env, () => convId);

    const h: any = await handoff.execute!(
      { reason: "atención humana", summary: "cliente pide una persona", category: "other" },
      {} as any,
    );
    const p: any = await pause.execute!({ minutes: 60 }, {} as any);

    expect(p.ticketId).toBe(h.ticketId);
    expect(await tickets.listOpen()).toHaveLength(1);
    expect(telegramCalls()).toHaveLength(1);
  });

  it("no duplica ticket ni avisa dos veces (pausa primero)", async () => {
    const pause = pauseBotTool(env, () => convId);
    const handoff = handoffHumanTool(env, () => convId);

    const p: any = await pause.execute!({ minutes: 60 }, {} as any);
    const h: any = await handoff.execute!(
      { reason: "atención humana", summary: "cliente pide una persona", category: "other" },
      {} as any,
    );

    expect(h.ticketId).toBe(p.ticketId);
    expect(await tickets.listOpen()).toHaveLength(1);
    expect(telegramCalls()).toHaveLength(1);
  });

  it("un ticket resuelto no bloquea el aviso de la siguiente escalación", async () => {
    const pause = pauseBotTool(env, () => convId);
    const primero: any = await pause.execute!({ minutes: 60 }, {} as any);
    await tickets.resolve(primero.ticketId, "dueño");

    const segundo: any = await pause.execute!({ minutes: 60 }, {} as any);
    expect(segundo.ticketId).not.toBe(primero.ticketId);
    expect(telegramCalls()).toHaveLength(2);
  });
});
