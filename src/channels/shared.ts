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
  videoUrl?: string;
  /** Id de WhatsApp de este mensaje (para que otro lo pueda citar). */
  waId?: string;
  /** Id del mensaje que el cliente está citando al responder. */
  citaDe?: string;
  /** El cliente reaccionó con un emoji a un mensaje: no hay nada que contestar. */
  reaccion?: { emoji: string; mensajeId: string };
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
  /**
   * Quien manda es una persona del panel y necesita saber si salió de verdad:
   * si el canal rechaza el envío, se lanza el error en vez de solo registrarlo.
   * El bot no lo pide: una respuesta suya fallida no debe romper su turno.
   */
  exigirEntrega?: boolean;
  /** El canal anota aquí los ids con que el proveedor identificó lo que salió. */
  idsEnviados?: string[];
  /** Responder citando este mensaje (el id que le dio WhatsApp). Solo WhatsApp Cloud. */
  citaDe?: string;
}

export interface ChannelAdapter {
  parseIncoming(request: Request, env: any): Promise<IncomingMessage>;
  sendReply(reply: OutgoingReply, env: any): Promise<void>;
  showTyping?(channelUserId: string, env: any): Promise<void>;
}
