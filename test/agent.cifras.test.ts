import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mismo arnés que test/agent.media.test.ts: el SDK de agents importa
// `cloudflare:workers`, que Node no resuelve, y el LLM va simulado.
vi.mock("agents", () => ({
  Agent: class {
    ctx: any;
    env: any;
    state: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    setState(s: any) {
      this.state = s;
    }
    sql(..._args: any[]) {
      return undefined;
    }
  },
}));

const streamTextMock = vi.fn();
vi.mock("ai", () => ({
  streamText: (...args: any[]) => streamTextMock(...args),
  tool: (def: any) => def,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => (modelId: string) => ({ modelId }),
}));

const openTicketAndNotify = vi.fn(async () => ({ ticketId: "t-1", notified: true }));
vi.mock("../src/tools/escalate", () => ({
  openTicketAndNotify: (...args: any[]) => (openTicketAndNotify as any)(...args),
}));

import { SupportAgent } from "../src/agent";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo } from "../src/db/settings";
import { RESPUESTA_SIN_CIFRA } from "../src/replies/cifras";
import * as senderMod from "../src/replies/sender";

function resultado(text: string, toolCalls: { toolName: string; input: unknown }[] = []) {
  async function* gen() {
    yield text;
  }
  return { textStream: gen(), steps: Promise.resolve([{ toolCalls }]) };
}

/** El bot con el negocio de member/config.local.ts y un historial dado. */
async function correr(
  respuestas: string[],
  historial: { role: string; content: string }[],
  llamadas: { toolName: string; input: unknown }[][] = [],
) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
  const env: any = {
    DB: {},
    AI: { run: vi.fn() },
    ANTHROPIC_API_KEY: "sk-ant-test",
    BOT_TIER: "pro",
    BOT_LANGUAGE: "es",
    BUFFER_SECONDS: "8",
    BOT_NAME: "PanaClaw",
    BUSINESS_NAME: "PanaClaw",
  };
  const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn() } }, env);
  agent.setState({
    conversationId: "conv-1",
    channel: "whatsapp",
    channelUserId: "50760000000",
    pendingMessages: [{ text: historial[historial.length - 1].content, receivedAt: Date.now() }],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  });

  let i = 0;
  streamTextMock.mockReset();
  streamTextMock.mockImplementation(() => {
    const n = i++;
    return resultado(respuestas[Math.min(n, respuestas.length - 1)], llamadas[n] ?? []);
  });
  const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m1" as any);
  vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue(historial as any);
  vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
  const sendReply = vi.fn(async () => {});
  vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply } as any);

  await agent.processBuffer();
  const enviado = (sendReply.mock.calls[0] as any)[0].chunks.join("\n");
  return { enviado, llamadas: streamTextMock.mock.calls.map((c) => c[0]), append };
}

describe("guardia de cifras dentro del bot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    openTicketAndNotify.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  const CLIENTE = { role: "user", content: "Hola, vi el anuncio de la página web de $295 en 72 horas. Quiero información." };

  it("la respuesta al cliente del anuncio sale tal cual, sin reescribir", async () => {
    const buena = "¡Hola! 👋 Sí — PanaClaw Start: $295 — 72 horas. Una página con lo esencial y publicación incluida.";
    const { enviado, llamadas } = await correr([buena], [CLIENTE]);
    expect(llamadas).toHaveLength(1);
    expect(enviado).toContain("$295");
    expect(enviado).not.toContain(RESPUESTA_SIN_CIFRA.slice(0, 30));
  });

  it("si insiste en una cifra inventada, se quita esa frase y el resto llega", async () => {
    const mala =
      "¡Hola! El plan Start es una página lista en 72 horas, con publicación incluida. " +
      "Se paga 50 % al arrancar ($147.50) y 50 % a la entrega.";
    const { enviado, llamadas } = await correr([mala, mala], [CLIENTE]);
    expect(llamadas).toHaveLength(2);
    expect(enviado).toContain("lista en 72 horas");
    expect(enviado).not.toMatch(/147/);
    expect(openTicketAndNotify).not.toHaveBeenCalled();
  });

  it("la corrección le dice al modelo qué frase tocar, y solo deja las tools que consultan", async () => {
    const mala = "El Start cuesta $295. Se paga 50 % al arrancar ($147.50).";
    const { llamadas } = await correr([mala, "El Start cuesta $295, mitad al arrancar y mitad a la entrega."], [CLIENTE]);
    const aviso = llamadas[1].system.map((b: any) => b.content).join("\n");
    expect(aviso).toContain("«Se paga 50 % al arrancar ($147.50).»");
    expect(Object.keys(llamadas[0].tools)).toContain("captureLead");
    expect(Object.keys(llamadas[1].tools)).not.toContain("captureLead");
    expect(Object.keys(llamadas[1].tools)).not.toContain("handoffHuman");
    expect(Object.keys(llamadas[1].tools)).toContain("searchKb");
  });

  it("si no queda nada que mandar, la respuesta de respaldo AVISA al dueño (promete una persona)", async () => {
    const { enviado } = await correr(["Son $147.50.", "Son $147.50."], [CLIENTE]);
    // El chunker la parte en dos burbujas; el texto es el mismo.
    expect(enviado.replace(/\n/g, " ")).toBe(RESPUESTA_SIN_CIFRA);
    expect(openTicketAndNotify).toHaveBeenCalledTimes(1);
    expect((openTicketAndNotify.mock.calls[0] as any)[2].summary).toContain("$147.50");
  });

  it("una cifra que ya dio una persona del equipo en la conversación está respaldada", async () => {
    const historial = [
      CLIENTE,
      { role: "owner", content: "Te lo dejamos en $260 por ser cliente referido." },
      { role: "user", content: "¿Entonces cuánto quedaba?" },
    ];
    const { llamadas, enviado } = await correr(["Quedaba en $260, como te dijo el equipo."], historial);
    expect(llamadas).toHaveLength(1);
    expect(enviado).toContain("$260");
  });

  it("en WhatsApp el bot recibe el número del cliente y las reglas del que llega de un anuncio", async () => {
    const { llamadas } = await correr(["¡Hola! Sí, es nuestro plan Start."], [CLIENTE]);
    const bloques = llamadas[0].system.map((b: any) => String(b.content));
    const canal = bloques.slice(1).find((b: string) => b.startsWith("<canal>"));
    expect(canal).toContain("WhatsApp");
    expect(canal).toContain("+50760000000");
    expect(canal).toMatch(/no se lo pidas/);
    expect(bloques[0]).toContain("<quien_llega_de_un_anuncio>");
  });

  // Codex, PR #40: la reescritura reemplazaba el registro de tools del turno, y
  // un captureLead del primer intento desaparecía del panel y de las stats.
  it("lo que hizo el primer intento queda anotado aunque haya reescritura", async () => {
    const mala = "El Start cuesta $295. Se paga 50 % al arrancar ($147.50).";
    const lead = { toolName: "captureLead", input: { intent: "Start" } };
    const busqueda = { toolName: "searchKb", input: { query: "start" } };
    const { append } = await correr([mala, "El Start cuesta $295."], [CLIENTE], [[lead], [busqueda]]);
    const delBot = append.mock.calls.find((c: any[]) => c[1] === "assistant") as any[];
    expect(delBot[3].toolCalls).toEqual([lead, busqueda]);
  });
});
