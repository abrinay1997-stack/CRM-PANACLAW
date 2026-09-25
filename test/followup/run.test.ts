/**
 * El seguimiento: 5 horas, 3 días y 7 días sin respuesta, SOLO en horario
 * laboral, redactado por la IA con el contexto de la conversación, y nunca a
 * quien dijo que no le interesa. D1 real (miniflare); el modelo y el adapter
 * del canal son dobles que anotan lo que recibieron.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
const sendReplyMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../src/llm/provider", () => ({
  createModel: () => ({ provider: "anthropic", modelId: "modelo-test", model: {}, supportsPromptCache: true }),
}));

vi.mock("../../src/replies/sender", () => ({
  pickAdapter: () => ({ sendReply: (...a: unknown[]) => sendReplyMock(...a) }),
}));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { runFollowups, noQuiereSeguimiento, NO_ENVIAR } from "../../src/followup/run";
import { pausarPorHumano, devolverAlBot } from "../../src/takeover";
import type { Env } from "../../src/env";

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
// Martes 22-sep-2026, 10:00 a.m. de Bogotá (15:00 UTC): en horario.
const MARTES_10AM = Date.UTC(2026, 8, 22, 15, 0, 0);

let env: Env;
let db: Db;
let convs: ConversationsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as never);
  convs = new ConversationsRepo(db);
  env = {
    DB: d1,
    BOT_TIMEZONE: "America/Bogota",
    BOT_NAME: "PanaClaw",
    BUSINESS_NAME: "PanaClaw",
    BOT_LANGUAGE: "es-419",
  } as unknown as Env;
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "Buenos días. ¿Pudo revisar la cotización de los precintos plásticos?",
    totalUsage: { inputTokens: 10, outputTokens: 5 },
  });
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue(undefined);
});

/** El cliente escribió en `userAt`, el bot contestó en `botAt`. */
async function conversacion(
  id: string,
  userAt: number,
  botAt: number,
  opts: { channel?: string; texto?: string } = {},
): Promise<string> {
  const conv = await convs.getOrCreate(opts.channel ?? "whatsapp-qr", id, `Cliente ${id}`);
  await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)", [
    `${id}-u`,
    conv.id,
    opts.texto ?? "¿Cuánto valen 500 precintos plásticos para Medellín?",
    userAt,
  ]);
  await db.run(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'Con gusto, le comparto la cotización…', ?)",
    [`${id}-a`, conv.id, botAt],
  );
  await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [botAt, conv.id]);
  return conv.id;
}

const prompts = () => generateTextMock.mock.calls.map((c) => (c[0] as { prompt: string }).prompt);

describe("los tres pasos", () => {
  it("a las 5 horas sale el primero, y antes no", async () => {
    await conversacion("a", MARTES_10AM - 6 * HORA, MARTES_10AM - 4 * HORA);
    expect((await runFollowups(env, { now: MARTES_10AM })).sent).toBe(0);

    const r = await runFollowups(env, { now: MARTES_10AM + HORA + 1 });
    expect(r.sent).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).toMatch(/primer seguimiento/);
  });

  it("3 días después sale el segundo, 7 días después el tercero, y ahí se para", async () => {
    await conversacion("b", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    await runFollowups(env, { now: MARTES_10AM + 3 * DIA }); // viernes 10 a.m.
    await runFollowups(env, { now: MARTES_10AM + 10 * DIA }); // viernes siguiente
    await runFollowups(env, { now: MARTES_10AM + 17 * DIA });
    expect(sendReplyMock).toHaveBeenCalledTimes(3);
    expect(prompts()[1]).toMatch(/segundo seguimiento/);
    expect(prompts()[2]).toMatch(/último seguimiento/);
  });

  it("si el cliente contesta, el ciclo vuelve a empezar desde el primero", async () => {
    const id = await conversacion("c", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('c-u2', ?, 'user', 'mañana le confirmo', ?)", [
      id,
      MARTES_10AM + HORA,
    ]);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('c-a2', ?, 'assistant', 'Con gusto', ?)", [
      id,
      MARTES_10AM + HORA,
    ]);
    await db.run("UPDATE conversations SET last_message_at = ? WHERE id = ?", [MARTES_10AM + HORA, id]);
    await runFollowups(env, { now: MARTES_10AM + 6 * HORA + 1 });
    expect(sendReplyMock).toHaveBeenCalledTimes(2);
    expect(prompts()[1]).toMatch(/primer seguimiento/);
  });
});

describe("solo en horario laboral", () => {
  it("un paso que se vence de noche espera a la mañana del día hábil", async () => {
    // El bot contestó a las 5 p.m.; las 5 h se cumplen a las 10 p.m.
    await conversacion("n", MARTES_10AM + 6 * HORA, MARTES_10AM + 7 * HORA);
    const noche = await runFollowups(env, { now: MARTES_10AM + 12 * HORA }); // 10 p.m.
    expect(noche.outsideHours).toBe(true);
    expect(sendReplyMock).not.toHaveBeenCalled();
    await runFollowups(env, { now: MARTES_10AM + DIA - HORA }); // miércoles 9 a.m.
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

  it("el fin de semana no sale nada", async () => {
    await conversacion("s", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    const sabado = MARTES_10AM + 4 * DIA; // sábado 10 a.m.
    const r = await runFollowups(env, { now: sabado });
    expect(r.outsideHours).toBe(true);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  it("el horario del panel manda: con sábado incluido, el sábado sí sale", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.businessHours, "L-S 8:00-12:00");
    await conversacion("s2", MARTES_10AM + 3 * DIA, MARTES_10AM + 3 * DIA); // viernes 10 a.m.
    await runFollowups(env, { now: MARTES_10AM + 4 * DIA - HORA }); // sábado 9 a.m. (23 h después)
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});

describe("el mensaje sale del contexto y del trato del negocio", () => {
  it("el prompt lleva la conversación, el tono del panel y el trato que ya se usó", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.tone, "formal y profesional");
    await new SettingsRepo(db).set(SETTING_KEYS.botName, "Charly");
    await conversacion("t", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    const p = prompts()[0];
    expect(p).toContain("500 precintos plásticos para Medellín");
    expect(p).toContain("formal y profesional");
    expect(p).toMatch(/el mismo que usaste en la conversación/);
    expect(p).toContain("Eres Charly");
    expect(p).not.toMatch(/mexicano/i);
    expect(p).toContain('"Buenos días"');
    expect(sendReplyMock.mock.calls[0][0].chunks[0]).toMatch(/cotización de los precintos/);
  });

  it("si el modelo dice NO_ENVIAR, no sale nada y el ciclo se cierra", async () => {
    generateTextMock.mockResolvedValue({ text: NO_ENVIAR, totalUsage: {} });
    await conversacion("x", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    await runFollowups(env, { now: MARTES_10AM + 3 * DIA });
    await runFollowups(env, { now: MARTES_10AM + 10 * DIA });
    expect(sendReplyMock).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("el mensaje queda en la bandeja como del asistente", async () => {
    const id = await conversacion("m", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    const ultimo = await db.first<{ role: string; model_used: string }>(
      "SELECT role, model_used FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
      [id],
    );
    expect(ultimo).toEqual({ role: "assistant", model_used: "seguimiento-1" });
  });
});

describe("a quién nunca", () => {
  it("a quien dijo que no le interesa: ni ahora ni después", async () => {
    const id = await conversacion("no", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA, {
      texto: "No, gracias, ya no me interesa",
    });
    await runFollowups(env, { now: MARTES_10AM });
    await runFollowups(env, { now: MARTES_10AM + 3 * DIA });
    expect(sendReplyMock).not.toHaveBeenCalled();
    const meta = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [id]);
    expect(JSON.parse(meta!.metadata).sin_seguimiento).toBe(true);
  });

  it("pausar y devolver al bot no le borran la marca de 'no me escriban'", async () => {
    const id = await conversacion("no2", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA, {
      texto: "no me escriban más",
    });
    await runFollowups(env, { now: MARTES_10AM });
    await pausarPorHumano(env, id, "panel");
    await devolverAlBot(env, id, { quien: "panel" });
    const meta = JSON.parse(
      (await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [id]))!.metadata,
    );
    expect(meta.sin_seguimiento).toBe(true);
    expect(meta.atiende).toBeUndefined();
  });

  it("a una conversación pausada (la atiende una persona)", async () => {
    const id = await conversacion("p", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await convs.setPausedUntil(id, MARTES_10AM + DIA);
    await runFollowups(env, { now: MARTES_10AM });
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  it("si el último mensaje es del cliente (eso es un pendiente, no un seguimiento)", async () => {
    const id = await conversacion("u", MARTES_10AM - 7 * HORA, MARTES_10AM - 6 * HORA);
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('u-2', ?, 'user', '¿sigue ahí?', ?)", [
      id,
      MARTES_10AM - 5 * HORA,
    ]);
    await runFollowups(env, { now: MARTES_10AM });
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  it("con el bot en pausa global", async () => {
    await new SettingsRepo(db).set(SETTING_KEYS.botPaused, "1");
    await conversacion("g", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await runFollowups(env, { now: MARTES_10AM });
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  it("por Instagram oficial (apagado)", async () => {
    await conversacion("ig", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA, { channel: "instagram" });
    await runFollowups(env, { now: MARTES_10AM });
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  it("por un canal con ventana de 24 h, pasada la ventana (los de 3 y 7 días)", async () => {
    await conversacion("w", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA, { channel: "whatsapp" });
    await runFollowups(env, { now: MARTES_10AM });
    await runFollowups(env, { now: MARTES_10AM + 3 * DIA });
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

  it("dos corridas cruzadas no mandan el mismo paso dos veces", async () => {
    await conversacion("d", MARTES_10AM - 6 * HORA, MARTES_10AM - 5 * HORA);
    await Promise.all([runFollowups(env, { now: MARTES_10AM }), runFollowups(env, { now: MARTES_10AM })]);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});

describe("noQuiereSeguimiento", () => {
  it.each([
    "No me interesa",
    "no estoy interesado",
    "No, gracias",
    "ya compré con otro proveedor",
    "no me vuelvan a escribir",
    "DEJEN DE ESCRIBIRME",
  ])("reconoce «%s»", (t) => expect(noQuiereSeguimiento(t)).toBe(true));

  it.each(["¿me interesa saber el precio?", "Gracias, lo reviso", "necesito 500 unidades"])(
    "no confunde «%s»",
    (t) => expect(noQuiereSeguimiento(t)).toBe(false),
  );
});
