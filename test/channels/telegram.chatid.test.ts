import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { answerTelegramChatId } from "../../src/channels/telegram";
import type { Env } from "../../src/env";

/**
 * El aviso de handoff por Telegram necesita OWNER_TELEGRAM_CHAT_ID, y el dueño
 * no tiene cómo saber ese número sin llamar a getUpdates a mano. El bot lo
 * contesta él mismo: siempre con `/miid`, y con `/start` mientras la variable
 * siga sin configurar (que es justo el momento de la instalación).
 */

function makeReq(body: unknown): Request {
  return new Request("https://bot.test/webhooks/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const update = (text: string) => ({
  update_id: 1,
  message: {
    message_id: 10,
    from: { id: 987654321, first_name: "Hugo", is_bot: false },
    chat: { id: 987654321, type: "private" },
    date: 1,
    text,
  },
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

afterEach(() => vi.restoreAllMocks());

const sentText = () =>
  JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)).text as string;

describe("answerTelegramChatId", () => {
  const env = { TELEGRAM_BOT_TOKEN: "tok" } as Env;

  it("contesta el chat id a /start cuando OWNER_TELEGRAM_CHAT_ID falta", async () => {
    expect(await answerTelegramChatId(makeReq(update("/start")), env)).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/bottok/sendMessage");
    expect(sentText()).toContain("987654321");
    // Ya no manda a la terminal: el vínculo se hace desde el panel.
    expect(sentText()).toContain("Vincular mi Telegram");
    expect(sentText()).not.toContain("wrangler");
  });

  it("deja pasar /start al agente una vez configurado (el cliente ve un saludo, no un número)", async () => {
    const configured = { ...env, OWNER_TELEGRAM_CHAT_ID: "987654321" } as Env;
    expect(await answerTelegramChatId(makeReq(update("/start")), configured)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("contesta /miid siempre, para reconfigurar sin adivinar", async () => {
    const configured = { ...env, OWNER_TELEGRAM_CHAT_ID: "111" } as Env;
    expect(await answerTelegramChatId(makeReq(update("/miid")), configured)).toBe(true);
    expect(sentText()).toContain("987654321");
  });

  it("acepta la forma /miid@mi_bot que Telegram usa en grupos", async () => {
    expect(await answerTelegramChatId(makeReq(update("/miid@mi_negocio_bot")), env)).toBe(true);
  });

  it("no intercepta un mensaje normal de cliente", async () => {
    expect(await answerTelegramChatId(makeReq(update("hola, tienen cita hoy?")), env)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no hace nada sin TELEGRAM_BOT_TOKEN", async () => {
    expect(await answerTelegramChatId(makeReq(update("/miid")), {} as Env)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
