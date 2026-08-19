/**
 * Tests del Follow-up bot: selección conservadora (caliente / activo),
 * ventana 3-20h, exclusiones (pausadas, instagram, último mensaje
 * del cliente, ya enviado), claim único de por vida y caps. LLM + adapter
 * mockeados; D1 real via miniflare.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const sendReplyMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({
    provider: "anthropic",
    modelId: "modelo-test",
    model: {},
    supportsPromptCache: true,
  }),
}));

vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply: (...a: unknown[]) => sendReplyMock(...a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { InsightsRepo } from "../../src/db/insights";
import {
  pickFollowupCandidates,
  runFollowups,
  MIN_IDLE_MS,
  MAX_IDLE_MS,
} from "../../src/followup/run";
import type { Env } from "../../src/env";

let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;
let insights: InsightsRepo;

/*
 * Un instante FIJO y dentro del horario laboral: miércoles 19 de agosto de 2026,
 * 19:00 UTC = 14:00 en Panamá (GMT-5).
 *
 * Antes era `Date.now()`. Desde que el follow-up respeta el horario del negocio,
 * eso volvía la suite dependiente de la hora a la que se corriera: verde a media
 * tarde y roja de madrugada, que es cuando suele correr CI. El horario tiene sus
 * propios casos más abajo, con sus propios instantes.
 */
const NOW = Date.UTC(2026, 7, 19, 19, 0, 0); // miércoles 19/08/2026, 14:00 en Panamá
const IDLE_OK = NOW - MIN_IDLE_MS - 60 * 60 * 1000; // 4h atrás: dentro de la ventana

/** Conversación con user→assistant terminada hace `userAt`. */
async function seed(
  userId: string,
  opts: { channel?: string; userMsgs?: number; userAt?: number; endsWithUser?: boolean } = {},
): Promise<string> {
  const channel = opts.channel ?? "manychat";
  const userAt = opts.userAt ?? IDLE_OK;
  const conv = await convs.getOrCreate(channel, userId, `Lead ${userId}`);
  const n = opts.userMsgs ?? 1;
  for (let i = 0; i < n; i++) {
    await msgs.append(conv.id, "user", `pregunta ${i + 1}`, { createdAt: userAt - (n - i) * 1000 });
  }
  if (!opts.endsWithUser) {
    await msgs.append(conv.id, "assistant", "respuesta del bot", { createdAt: userAt + 500 });
  }
  await convs.touchLastMessage(conv.id, userAt + (opts.endsWithUser ? 0 : 500));
  return conv.id;
}

async function markHot(convId: string) {
  await insights.upsert({
    conversationId: convId,
    sentiment: "positive",
    resolution: "unresolved",
    botScore: 4,
    topics: [],
    summary: "interesado",
    missedKb: null,
    saleOpportunity: true,
  });
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    BOT_NAME: "Ana",
    BUSINESS_NAME: "Mi Negocio",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BUFFER_SECONDS: "8",
    BOT_TIMEZONE: "America/Panama",
    MANYCHAT_API_KEY: "mc-test",
  } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  insights = new InsightsRepo(db);
  generateTextMock.mockReset().mockResolvedValue({ text: "¿Quedaste con alguna duda? Aquí ando." });
  sendReplyMock.mockReset().mockResolvedValue(undefined);
});

describe("pickFollowupCandidates — selección", () => {
  it("elige calientes (sale_opportunity) y activos (4+ msgs); ignora al resto", async () => {
    const hot = await seed("hot");
    await markHot(hot);
    await seed("active", { userMsgs: 4 });
    await seed("quiet"); // 1 mensaje, sin señales → NO

    const c = await pickFollowupCandidates(env, NOW, 10);
    const byId = Object.fromEntries(c.map((x) => [x.id, x.reason]));
    expect(byId[hot]).toBe("hot");
    expect(byId["manychat:active"]).toBe("active");
    expect(byId["manychat:quiet"]).toBeUndefined();
    expect(c).toHaveLength(2);
  });

  it("respeta la ventana 3-20h y las exclusiones", async () => {
    const fresh = await seed("fresh", { userAt: NOW - 30 * 60 * 1000 }); // hace 30 min
    await markHot(fresh);
    const stale = await seed("stale", { userAt: NOW - MAX_IDLE_MS - 60 * 60 * 1000 }); // hace 21h
    await markHot(stale);
    const pending = await seed("pending", { endsWithUser: true }); // terminó hablando el cliente
    await markHot(pending);
    const ig = await seed("igdead", { channel: "instagram" });
    await markHot(ig);
    const paused = await seed("paused");
    await markHot(paused);
    await convs.setPausedUntil(paused, NOW + 60 * 60 * 1000);

    const c = await pickFollowupCandidates(env, NOW, 10);
    expect(c).toHaveLength(0);
  });
});

describe("runFollowups — envío y garantías", () => {
  it("manda UN follow-up por candidato, lo persiste como assistant y lo registra", async () => {
    const hot = await seed("h1");
    await markHot(hot);

    const r = await runFollowups(env, { now: NOW });
    expect(r).toMatchObject({ sent: 1, skipped: 0, errors: 0 });
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [payload] = sendReplyMock.mock.calls[0];
    expect(payload.channelUserId).toBe("h1");
    expect(payload.chunks[0]).toContain("duda");

    const history = await msgs.lastN(hot, 5);
    expect(history[history.length - 1].role).toBe("assistant");
    expect(history[history.length - 1].content).toContain("duda");

    // El prompt llevó contexto real y la razón
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("pregunta 1");
    expect(prompt).toContain("venta o interés abierto");
  });

  it("NUNCA repite: la segunda corrida no le manda a nadie", async () => {
    const hot = await seed("h2");
    await markHot(hot);
    await runFollowups(env, { now: NOW });
    const r2 = await runFollowups(env, { now: NOW });
    expect(r2.sent).toBe(0);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

  it("si el envío falla, el claim se queda (no reintenta a ese cliente)", async () => {
    sendReplyMock.mockRejectedValueOnce(new Error("manychat 500"));
    const hot = await seed("h3");
    await markHot(hot);

    const r = await runFollowups(env, { now: NOW });
    expect(r.errors).toBe(1);
    const r2 = await runFollowups(env, { now: NOW });
    expect(r2.sent).toBe(0); // claimed — no double touch
  });

  it("respeta el cap diario", async () => {
    for (const u of ["c1", "c2", "c3"]) {
      const id = await seed(u);
      await markHot(id);
    }
    const r = await runFollowups(env, { now: NOW, dailyCap: 2 });
    expect(r.sent).toBe(2);
  });

  /*
   * El horario laboral del negocio manda sobre TODO lo demás.
   *
   * Es la única regla del follow-up que protege al cliente y no al negocio: un
   * mensaje de madrugada no se recupera pidiendo perdón, y en WhatsApp es de
   * las cosas por las que a un número lo bloquean. Por eso se comprueba que la
   * noche, la madrugada y el fin de semana no mandan nada, y que además no
   * quemen el claim de por vida de la conversación.
   */
  describe("horario laboral", () => {
    const MIERCOLES_3AM = Date.UTC(2026, 7, 19, 8, 0, 0); // 03:00 en Panamá
    const MIERCOLES_10PM = Date.UTC(2026, 7, 20, 3, 0, 0); // miércoles 22:00 en Panamá
    const DOMINGO_MEDIODIA = Date.UTC(2026, 7, 23, 17, 0, 0); // domingo 12:00 en Panamá

    it.each([
      ["de madrugada", MIERCOLES_3AM],
      ["de noche", MIERCOLES_10PM],
      ["en fin de semana", DOMINGO_MEDIODIA],
    ])("no manda nada %s", async (_caso, instante) => {
      const hot = await seed("hh", { userAt: instante - MIN_IDLE_MS - 60 * 60 * 1000 });
      await markHot(hot);

      const r = await runFollowups(env, { now: instante });
      expect(r.sent).toBe(0);
      expect(r.outsideHours).toBe(true);
      expect(sendReplyMock).not.toHaveBeenCalled();

      // No se gastó el claim: el mismo lead sigue siendo elegible de día.
      const claimed = await db.first<{ n: number }>(
        "SELECT COUNT(*) as n FROM followup_sends",
      );
      expect(claimed?.n ?? 0).toBe(0);
    });

    it("el mismo lead sí recibe el toque al día siguiente en horario", async () => {
      const hot = await seed("hh2", { userAt: MIERCOLES_3AM - MIN_IDLE_MS - 60 * 60 * 1000 });
      await markHot(hot);
      expect((await runFollowups(env, { now: MIERCOLES_3AM })).sent).toBe(0);

      // 11:00 en Panamá del mismo día, con su último mensaje 4 h antes.
      const enHorario = Date.UTC(2026, 7, 19, 16, 0, 0);
      await msgs.append(hot, "user", "sigo interesado", {
        createdAt: enHorario - MIN_IDLE_MS - 60 * 60 * 1000,
      });
      await msgs.append(hot, "assistant", "te cuento", {
        createdAt: enHorario - MIN_IDLE_MS - 60 * 60 * 1000 + 500,
      });

      const r = await runFollowups(env, { now: enHorario });
      expect(r.sent).toBe(1);
      expect(sendReplyMock).toHaveBeenCalledTimes(1);
    });

    it("respeta el horario configurado en el panel, no solo el de por defecto", async () => {
      const { SettingsRepo, SETTING_KEYS } = await import("../../src/db/settings");
      // Sábados incluidos y hasta las 23:00: hay negocios que trabajan de noche.
      await new SettingsRepo(db).set(SETTING_KEYS.businessHours, "L-S 09:00-23:00");
      const hot = await seed("hh3", { userAt: MIERCOLES_10PM - MIN_IDLE_MS - 60 * 60 * 1000 });
      await markHot(hot);

      const r = await runFollowups(env, { now: MIERCOLES_10PM });
      expect(r.sent).toBe(1);
    });
  });

  it("no hace nada con el bot pausado globalmente", async () => {
    const { SettingsRepo, SETTING_KEYS } = await import("../../src/db/settings");
    await new SettingsRepo(db).set(SETTING_KEYS.botPaused, "1");
    const hot = await seed("h4");
    await markHot(hot);
    const r = await runFollowups(env, { now: NOW });
    expect(r.sent).toBe(0);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });
});
