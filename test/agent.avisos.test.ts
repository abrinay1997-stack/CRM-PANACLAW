import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mismo arnés que test/agent.cifras.test.ts.
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

const avisarAlDueno = vi.fn(async () => true);
vi.mock("../src/owner/avisos", () => ({ avisarAlDueno: (...a: any[]) => (avisarAlDueno as any)(...a) }));
const reciente = { valor: false };
vi.mock("../src/owner/acciones", () => ({ avisoReciente: async () => reciente.valor }));
vi.mock("../src/tools/escalate", () => ({ openTicketAndNotify: async () => ({ ticketId: "t-1", notified: true }) }));

import { SupportAgent, paraElModelo } from "../src/agent";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import { SettingsRepo } from "../src/db/settings";
import * as senderMod from "../src/replies/sender";

async function correr(texto: string) {
  vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
  const env: any = { DB: {}, AI: { run: vi.fn() }, ANTHROPIC_API_KEY: "sk-ant-test", BOT_TIER: "pro", BOT_LANGUAGE: "es", BUFFER_SECONDS: "8", BOT_NAME: "PanaClaw", BUSINESS_NAME: "PanaClaw" };
  const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn() } }, env);
  agent.setState({ conversationId: "conv-1", channel: "whatsapp", channelUserId: "50760000000", pendingMessages: [{ text: texto, receivedAt: Date.now() }], lastAlarmAt: 0, lastUserLang: "es", toolCallsInLast2Turns: 0, lastSearchKbScore: 1, imageRetryCount: 0 });
  streamTextMock.mockReset();
  streamTextMock.mockImplementation(() => {
    async function* gen() {
      yield "¡Hola! ¿En qué te ayudo?";
    }
    return { textStream: gen(), steps: Promise.resolve([{ toolCalls: [] }]) };
  });
  vi.spyOn(MessagesRepo.prototype, "append").mockResolvedValue("m1" as any);
  vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: texto }] as any);
  vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
  vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
  vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply: vi.fn(async () => {}) } as any);
  await agent.processBuffer();
  return streamTextMock.mock.calls[0]?.[0];
}

describe("aviso de mensaje nuevo al Telegram del dueño", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    avisarAlDueno.mockClear();
    reciente.valor = false;
  });
  afterEach(() => vi.restoreAllMocks());

  it("cada mensaje de un cliente le llega al dueño, con el texto y si vino de un anuncio", async () => {
    await correr("Hola, quiero una página\n[ANUNCIO: llegó desde un anuncio de Meta: «Tu web en 72 horas»]");
    const aviso = (avisarAlDueno.mock.calls as any[]).find((c) => c[1].titulo === "💬 Mensaje nuevo")?.[1];
    expect(aviso).toBeDefined();
    expect(aviso.cuerpo).toContain("Hola, quiero una página");
    expect(aviso.cuerpo).not.toContain("[ANUNCIO:");
    expect(aviso.cuerpo).toContain("📣 Llegó desde un anuncio.");
    expect(aviso.conversationId).toBe("conv-1");
  });

  it("si ya hubo un aviso en esta conversación hace poco, no le llena el teléfono", async () => {
    reciente.valor = true;
    await correr("¿Y cuánto tarda?");
    expect((avisarAlDueno.mock.calls as any[]).some((c) => c[1].titulo === "💬 Mensaje nuevo")).toBe(false);
  });
});

describe("el documento que manda el cliente", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("el modelo sabe que llegó, pero nunca ve el enlace", async () => {
    const texto = "aquí va mi comprobante\n[DOCUMENTO: https://bot.test/webhooks/whatsapp/media/M1?exp=1&sig=ab | pago.pdf]";
    const llamada = await correr(texto);
    const ultimo = llamada.messages.at(-1).content as string;
    expect(ultimo).not.toContain("https://bot.test");
    expect(ultimo).toContain("adjuntó un documento");
    expect(ultimo).toContain("NUNCA des por recibido un pago");
  });

  it("paraElModelo deja igual lo que no es un documento", () => {
    expect(paraElModelo("hola")).toBe("hola");
  });
});

// 31-oct-2026, Gabriel: la misma pregunta en seis mensajes y 🙌 en cinco
// seguidos. Las dos cosas se miran en el código, no solo en el prompt.
describe("lo que el bot ya dijo antes cuenta para el siguiente mensaje", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const sistemas: string[] = [];

  async function conHistoria(respuestas: string[], ajustes: Record<string, string> = { forma_de_trato: "tu" }) {
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue(ajustes);
    const env: any = { DB: {}, AI: { run: vi.fn() }, ANTHROPIC_API_KEY: "sk-ant-test", BOT_TIER: "pro", BOT_LANGUAGE: "es", BUFFER_SECONDS: "8", BOT_NAME: "PanaClaw", BUSINESS_NAME: "PanaClaw" };
    const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn() } }, env);
    agent.setState({ conversationId: "conv-1", channel: "whatsapp", channelUserId: "50760000000", pendingMessages: [{ text: "Dígame usted", receivedAt: Date.now() }], lastAlarmAt: 0, lastUserLang: "es", toolCallsInLast2Turns: 0, lastSearchKbScore: 1, imageRetryCount: 0 });
    streamTextMock.mockReset();
    let n = 0;
    sistemas.length = 0;
    streamTextMock.mockImplementation((args: any) => {
      // El arreglo de system se edita después de cada llamada: se copia ahora.
      sistemas.push((args.system ?? []).map((m: any) => m.content).join("\n"));
      const texto = respuestas[Math.min(n++, respuestas.length - 1)];
      async function* gen() {
        yield texto;
      }
      return { textStream: gen(), steps: Promise.resolve([{ toolCalls: [] }]) };
    });
    const guardado: string[] = [];
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(async (_c: any, rol: any, texto: any) => {
      if (rol === "assistant") guardado.push(texto);
      return "m1" as any;
    });
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([
      { role: "user", content: "Hola" },
      { role: "assistant", content: "Gracias Gabriel 🙌 ¿Qué negocio tienes?" },
      { role: "user", content: "Ya usted me dirá" },
      { role: "assistant", content: "¿Me cuenta cómo se llama su negocio?" },
      { role: "user", content: "Dígame usted" },
    ] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
    vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply: vi.fn(async () => {}) } as any);
    await agent.processBuffer();
    return guardado.join("\n");
  }

  it("la tercera vez que iba a preguntar lo mismo, la rehace", async () => {
    const final = await conHistoria([
      "Perfecto Gabriel. ¿Me cuenta qué negocio tiene?",
      "Entiendo, Gabriel. Si prefiere, una persona del equipo lo llama el lunes y lo vemos juntos.",
    ]);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(sistemas[1]).toContain("[pregunta-repetida]");
    expect(final).toContain("una persona del equipo lo llama");
    expect(final).not.toContain("qué negocio tiene");
  });

  // 2-nov-2026: de usted es profesional, y sin ningún emoji.
  it("de usted, el emoji no sale nunca", async () => {
    const final = await conHistoria(["Con gusto, Gabriel 🙌"], {});
    expect(final).toBe("Con gusto, Gabriel");
  });

  it("si el último mensaje llevaba emoji, este sale sin", async () => {
    const final = await conHistoria(["Con gusto, Gabriel 🙌"]);
    // El anterior del bot («¿Me cuenta cómo se llama su negocio?») no llevaba:
    // este conserva el suyo.
    expect(final).toBe("Con gusto, Gabriel 🙌");
  });
});

// Auditoría de Meta Ads (1-nov-2026): quien no viene a comprar recibe un cierre
// amable, y el primer mensaje a quien tocó un anuncio son 2 líneas.
describe("quien llega de un anuncio", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const sistemas: string[] = [];

  async function primerTurno(texto: string, respuestas: string[]) {
    vi.spyOn(SettingsRepo.prototype, "all").mockResolvedValue({});
    const env: any = { DB: {}, AI: { run: vi.fn() }, ANTHROPIC_API_KEY: "sk-ant-test", BOT_TIER: "pro", BOT_LANGUAGE: "es", BUFFER_SECONDS: "8", BOT_NAME: "PanaClaw", BUSINESS_NAME: "PanaClaw" };
    const agent: any = new (SupportAgent as any)({ storage: { setAlarm: vi.fn() } }, env);
    agent.setState({ conversationId: "conv-1", channel: "whatsapp", channelUserId: "50760000000", pendingMessages: [{ text: texto, receivedAt: Date.now() }], lastAlarmAt: 0, lastUserLang: "es", toolCallsInLast2Turns: 0, lastSearchKbScore: 1, imageRetryCount: 0 });
    streamTextMock.mockReset();
    sistemas.length = 0;
    let n = 0;
    streamTextMock.mockImplementation((args: any) => {
      sistemas.push((args.system ?? []).map((m: any) => m.content).join("\n"));
      const r = respuestas[Math.min(n++, respuestas.length - 1)];
      async function* gen() {
        yield r;
      }
      return { textStream: gen(), steps: Promise.resolve([{ toolCalls: [] }]) };
    });
    const guardado: string[] = [];
    vi.spyOn(MessagesRepo.prototype, "append").mockImplementation(async (_c: any, rol: any, t: any) => {
      if (rol === "assistant") guardado.push(t);
      return "m1" as any;
    });
    vi.spyOn(MessagesRepo.prototype, "lastN").mockResolvedValue([{ role: "user", content: texto }] as any);
    vi.spyOn(ConversationsRepo.prototype, "touchLastMessage").mockResolvedValue(undefined as any);
    vi.spyOn(ConversationsRepo.prototype, "isPaused").mockResolvedValue(false);
    vi.spyOn(senderMod, "pickAdapter").mockReturnValue({ sendReply: vi.fn(async () => {}) } as any);
    await agent.processBuffer();
    return guardado.join("\n");
  }

  const APERTURA = "Hola, vi el anuncio de la página web. Quiero información.\n[ANUNCIO: llegó desde un anuncio de Meta: «Tu página web»]";

  it("el plan completo de primeras se rehace corto", async () => {
    const larga =
      "¡Hola! Sí, es nuestro plan Start.\n\nIncluye varias secciones y el botón de WhatsApp.\n\nSe paga la mitad al empezar.\n\nNo incluye los textos ni las fotos.\n\n¿Qué negocio tiene?";
    const corta = "¡Hola! Sí, es nuestro plan Start.\n¿Es para un negocio que ya vende o para uno que va a abrir?";
    const final = await primerTurno(APERTURA, [larga, corta]);
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(sistemas[1]).toContain("[primera-larga]");
    expect(final).toBe(corta);
  });

  // 7-nov-2026: «Sí, es nuestro plan Start…» a secas le pareció seco al dueño.
  it("la primera respuesta sin saludo sale con el saludo de la hora y las gracias", async () => {
    const final = await primerTurno(APERTURA, ["Sí, es nuestra página web Start.\n¿Es para un negocio que ya vende o para uno que va a abrir?"]);
    expect(final).toMatch(/^(Buenos días|Buenas tardes|Buenas noches), gracias por escribirnos a PanaClaw\.\nSí, es nuestra página web Start\./);
  });

  it("si ya saludó, no se le pega otro saludo", async () => {
    const final = await primerTurno(APERTURA, ["Buen día. Sí, es nuestra página web Start.\n¿Ya vende o va a abrir?"]);
    expect(final).toBe("Buen día. Sí, es nuestra página web Start.\n¿Ya vende o va a abrir?");
  });

  it("a quien busca un préstamo, el bot recibe la nota de cerrar con amabilidad", async () => {
    const noCliente = await import("../src/noCliente");
    vi.spyOn(noCliente, "revisarNoCliente").mockResolvedValue("prestamo");
    await primerTurno("Quiero prestamo de 2000 dolares", ["Disculpe, no damos préstamos. Que le vaya bien."]);
    expect(sistemas[0]).toContain("<no_viene_a_comprar>");
    expect(sistemas[0]).toContain("no presta dinero");
  });

  it("a quien sí viene a comprar, sin nota", async () => {
    await primerTurno("Quiero la página para mi barbería", ["Con gusto. ¿Ya vende o va a abrir?"]);
    expect(sistemas[0]).not.toContain("<no_viene_a_comprar>");
  });
});
