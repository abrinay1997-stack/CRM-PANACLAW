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
import { RESPUESTA_SEGURA } from "../src/replies/revisor";
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
  ajustes: Record<string, string> = {},
) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue(ajustes);
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
  // El system de cada llamada, copiado en el momento: el agente quita la nota
  // del revisor después de usarla, y el array es el mismo objeto.
  const sistemas: string[] = [];
  streamTextMock.mockReset();
  streamTextMock.mockImplementation((args: any) => {
    sistemas.push(args.system.map((b: any) => String(b.content)).join("\n"));
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
  return { enviado, llamadas: streamTextMock.mock.calls.map((c) => c[0]), append, sistemas };
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
    const { llamadas, enviado } = await correr(["Quedaba en $260, como le dijo el equipo."], historial);
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

// El revisor (src/replies/revisor.ts), traído de Baby Caleb: lo que la
// respuesta no puede decir, mirado antes de mandarla.
describe("el revisor dentro del bot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    openTicketAndNotify.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  const PAGO = { role: "user", content: "Ya te pagué el 50 %, te mandé la captura." };
  const delRevisor = () =>
    openTicketAndNotify.mock.calls.map((c: any[]) => c[2]).find((a: any) => a.reason === "respuesta detenida");
  const CLIENTE = { role: "user", content: "Hola, vi el anuncio de la página web de $295 en 72 horas. Quiero información." };

  it("si insiste en dar el pago por recibido, no sale: respuesta segura y aviso al dueño", async () => {
    const mala = "¡Perfecto! Ya recibimos tu pago, arrancamos hoy.";
    const { enviado, llamadas } = await correr([mala, mala], [PAGO]);
    expect(llamadas).toHaveLength(2);
    expect(enviado.replace(/\n/g, " ")).toBe(RESPUESTA_SEGURA);
    // «Ya te pagué» ya abre su ticket antes del modelo (escalation-triggers);
    // el del revisor reutiliza ese mismo en producción (openTicketAndNotify).
    const aviso = delRevisor();
    expect(aviso).toBeDefined();
    expect(aviso.category).toBe("billing");
    expect(aviso.summary).toContain("pago-confirmado");
  });

  it("si la rehace bien, sale la corregida y nadie recibe un aviso de más", async () => {
    const mala = "¡Perfecto! Ya recibimos tu pago.";
    const buena = "¡Gracias! Una persona del equipo verifica tu pago y te confirma por aquí.";
    const { enviado, llamadas, sistemas } = await correr([mala, buena], [PAGO]);
    expect(enviado.replace(/\n/g, " ")).toBe(buena);
    expect(sistemas[1]).toContain("[pago-confirmado]");
    // La nota era para esa reescritura: no se queda pegada al prompt.
    expect(llamadas[1].system.map((b: any) => String(b.content)).join("\n")).not.toContain("<revision_de_tu_respuesta>");
    expect(Object.keys(llamadas[1].tools)).not.toContain("captureLead");
    expect(delRevisor()).toBeUndefined();
  });

  it("las frases prohibidas salen del panel", async () => {
    const ajustes = { frases_prohibidas: "te hago descuento | los precios son fijos" };
    const mala = "Por ser tú, te hago descuento en el Start.";
    const { enviado } = await correr([mala, mala], [CLIENTE], [], ajustes);
    expect(enviado.replace(/\n/g, " ")).toBe(RESPUESTA_SEGURA);
    expect(delRevisor()?.summary).toContain("frase-prohibida");
  });

  it("una respuesta normal no se toca ni se rehace", async () => {
    const buena = "¡Hola! Sí — PanaClaw Start: $295 — 72 horas. ¿Qué tipo de negocio tiene?";
    const { enviado, llamadas } = await correr([buena], [CLIENTE]);
    expect(llamadas).toHaveLength(1);
    expect(enviado.replace(/\n/g, " ")).toBe(buena);
  });
});

// La prueba del dueño con Muse Spark (25-oct-2026): «Te respondo en español —
// busco la info…» pegado al «¡Hola!», y la negrita con dos asteriscos.
describe("lo que llega al cliente por WhatsApp", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sin la narración de antes de buscar y con la negrita de WhatsApp", async () => {
    const narracion = "Te respondo en español — busco la info del plan de $295 para compartirte los detalles.";
    const respuesta = "¡Hola! Sí, es nuestro plan **PanaClaw Start** — $295 y entrega en 72 horas.";
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
    const env: any = { DB: {}, AI: { run: vi.fn() }, ANTHROPIC_API_KEY: "sk-ant-test", BOT_TIER: "pro", BOT_LANGUAGE: "es", BUFFER_SECONDS: "8", BOT_NAME: "PanaClaw", BUSINESS_NAME: "PanaClaw" };
    const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn() } }, env);
    const cliente = "Hola, vi el anuncio de la página web de $295 en 72 horas. Quiero información.";
    agent.setState({ conversationId: "conv-1", channel: "whatsapp", channelUserId: "50760000000", pendingMessages: [{ text: cliente, receivedAt: Date.now() }], lastAlarmAt: 0, lastUserLang: "es", toolCallsInLast2Turns: 0, lastSearchKbScore: 1, imageRetryCount: 0 });
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => {
      async function* gen() {
        yield narracion;
        yield respuesta;
      }
      return {
        textStream: gen(),
        steps: Promise.resolve([
          { text: narracion, toolCalls: [{ toolName: "searchKb", input: { query: "Start" } }] },
          { text: respuesta, toolCalls: [] },
        ]),
      };
    });
    const append = vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m1" as any);
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: cliente }] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
    vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
    const sendReply = vi.fn(async () => {});
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply } as any);

    await agent.processBuffer();

    const esperado = "¡Hola! Sí, es nuestro plan *PanaClaw Start* — $295 y entrega en 72 horas.";
    // El chunker lo parte en globos; el texto es el mismo.
    const enviado = (sendReply.mock.calls[0] as any)[0].chunks.join(" ");
    expect(enviado).toBe(esperado);
    // Lo guardado es lo mismo que vio el cliente.
    const guardado = append.mock.calls.find((c: any[]) => c[1] === "assistant") as any[];
    expect(guardado[2]).toBe(esperado);
  });
});

