export type ChannelId =
  | "manychat"
  | "telegram"
  | "twilio"
  | "messenger"
  | "instagram"
  | "whatsapp"
  /** WhatsApp vinculado por QR, vía el puente `panaclaw-wa`. Canal ALTERNO:
   *  Baileys no es oficial y el número puede ser baneado, así que la Cloud API
   *  ("whatsapp") se queda conectada como respaldo. */
  | "whatsapp-qr";

export interface IncomingMessage {
  channel: ChannelId;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  isOwnerMessage?: boolean;
  /** El clic del anuncio de WhatsApp, si el mensaje vino de uno (src/meta/conversiones.ts). */
  anuncio?: { ctwaClid: string; sourceId?: string; wabaId?: string; titular?: string };
  receivedAt: number;
  rawPayload: unknown;
}

export interface OutgoingReply {
  channel: ChannelId;
  channelUserId: string;
  chunks: string[];
  interChunkDelayMs?: number;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}
