import type { ChannelAdapter, IncomingMessage, OutgoingReply } from "./shared";
import type { Env } from "../env";

const TG_API = "https://api.telegram.org/bot";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name?: string; is_bot: boolean };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; width: number; height: number }[];
  };
}

export async function resolveTelegramFileUrl(
  fileId: string,
  token: string,
): Promise<string | null> {
  // Telegram files are NOT directly addressable by file_id. You must call
  // getFile to obtain a file_path, then download from
  // https://api.telegram.org/file/bot<token>/<file_path> (per Bot API docs).
  const res = await fetch(`${TG_API}${token}/getFile?file_id=${fileId}`);
  if (!res.ok) return null;
  const json: any = await res.json();
  if (!json?.ok) return null;
  return `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
}

/**
 * Responde el chat id del dueño a `/miid` (y a `/start` mientras el bot todavía
 * no tiene OWNER_TELEGRAM_CHAT_ID configurado).
 *
 * Sin esto, la única forma de conocer tu chat id era llamar a getUpdates a mano
 * — el paso donde se atoraba la configuración del aviso de handoff, y por eso
 * el panel terminaba mostrando "HANDOFF SIN AVISO".
 *
 * Devuelve true si ya contestó (el mensaje NO debe seguir al agente). `/start`
 * solo se intercepta mientras falta la configuración: una vez guardado el chat
 * id, el `/start` de un cliente vuelve a ser un saludo normal del bot.
 */
export async function answerTelegramChatId(request: Request, env: Env): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return false;
  }
  const msg = update?.message;
  const text = msg?.text?.trim().toLowerCase();
  if (!msg || !text) return false;

  // Telegram manda los comandos como "/miid" o "/miid@mi_bot" en grupos.
  const cmd = text.split(/[\s@]/)[0];
  const isMiId = cmd === "/miid";
  const isSetupStart = cmd === "/start" && !env.OWNER_TELEGRAM_CHAT_ID;
  if (!isMiId && !isSetupStart) return false;

  const chatId = String(msg.from.id);
  const body = isSetupStart
    ? `👋 Tu bot ya está escuchando.\n\nTu chat id es:\n${chatId}\n\n` +
      "Guárdalo para recibir los avisos cuando un cliente necesite una persona:\n" +
      "pnpm wrangler secret put OWNER_TELEGRAM_CHAT_ID"
    : `Tu chat id es:\n${chatId}`;

  await fetch(`${TG_API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: msg.chat.id, text: body }),
  }).catch((e) => console.error("[telegram] answerTelegramChatId failed:", e));
  return true;
}

export const telegramAdapter: ChannelAdapter = {
  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage> {
    const update = (await request.json()) as TgUpdate;
    const msg = update.message;
    if (!msg) throw new Error("not a message update");
    const channelUserId = String(msg.from.id);
    const displayName = msg.from.first_name;
    let text = msg.text;
    let audioUrl: string | undefined;
    let imageUrl: string | undefined;
    const token = env.TELEGRAM_BOT_TOKEN ?? "";
    if (msg.voice) {
      // Resolve to a real, fetchable HTTPS URL via getFile (see docs above).
      audioUrl = (await resolveTelegramFileUrl(msg.voice.file_id, token)) ?? undefined;
    } else if (msg.photo) {
      const largest = msg.photo[msg.photo.length - 1];
      imageUrl = (await resolveTelegramFileUrl(largest.file_id, token)) ?? undefined;
      text = msg.caption;
    }
    return {
      channel: "telegram",
      channelUserId,
      displayName,
      text,
      audioUrl,
      imageUrl,
      // The owner intervenes from their own Telegram account: detect by matching
      // the sender against OWNER_TELEGRAM_CHAT_ID (the same id used for handoff DMs).
      isOwnerMessage:
        env.OWNER_TELEGRAM_CHAT_ID != null &&
        channelUserId === String(env.OWNER_TELEGRAM_CHAT_ID),
      receivedAt: Date.now(),
      rawPayload: update,
    };
  },

  async sendReply(reply: OutgoingReply, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    for (let i = 0; i < reply.chunks.length; i++) {
      // typing indicator (best effort)
      await fetch(`${TG_API}${token}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: reply.channelUserId, action: "typing" }),
      }).catch(() => {});
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const res = await fetch(`${TG_API}${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: reply.channelUserId, text: reply.chunks[i] }),
      });
      // No te tragues el fallo. El mensaje ya se guardó en D1 antes de llegar
      // aquí, así que aparece en el panel pase lo que pase: si Telegram lo
      // rechaza y nadie lo registra, el síntoma es "el bot responde en el panel
      // pero al cliente no le llega nada", sin ninguna pista de por qué.
      //
      // Telegram devuelve el motivo en `description`, y suele ser muy concreto:
      //   401 Unauthorized              → TELEGRAM_BOT_TOKEN mal o de otro bot
      //   400 chat not found            → chat_id que ya no existe
      //   403 bot was blocked by the user → el cliente bloqueó al bot
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error(`telegram sendReply ${res.status}: ${errBody}`);
      }
    }
  },

  async showTyping(channelUserId: string, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    await fetch(`${TG_API}${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelUserId, action: "typing" }),
    }).catch(() => {});
  },
};
