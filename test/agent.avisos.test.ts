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
