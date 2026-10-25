/**
 * Friendly channel names for the dashboard + detection of which channels are
 * actually configured (env credentials present). Kept separate from shared.ts
 * so dashboard concerns don't touch the adapter contract.
 */
import type { Env } from "../env";

/** channel id (as stored in conversations.channel) → label the owner reads. */
export const CHANNEL_LABELS: Record<string, string> = {
  twilio: "WhatsApp",
  whatsapp: "WhatsApp", // Cloud API oficial de Meta (y filas viejas del canal)
  "whatsapp-qr": "WhatsApp (QR)",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  manychat: "ManyChat",
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "—";
  return CHANNEL_LABELS[channel] ?? channel;
}

/**
 * El teléfono del cliente, cuando el canal ya lo trae: en WhatsApp el chat ES
 * el número. El bot le pedía «¿cuál es tu número de teléfono?» a quien le
 * estaba escribiendo por WhatsApp (25-oct-2026), que suena a que no lee.
 *
 * null cuando el canal no lo da: Telegram, Instagram, o un `@lid` del canal
 * por QR, que es un identificador interno de WhatsApp y no un número.
 */
export function telefonoDelCliente(channel: string, channelUserId: string): string | null {
  const id = (channelUserId ?? "").trim();
  let digitos = "";
  if (channel === "whatsapp" || channel === "twilio") digitos = id.replace(/\D/g, "");
  else if (channel === "whatsapp-qr" && /@s\.whatsapp\.net$/.test(id)) digitos = id.split(/[@:]/)[0].replace(/\D/g, "");
  return digitos.length >= 7 && digitos.length <= 15 ? `+${digitos}` : null;
}

export interface ConfiguredChannel {
  id: string;
  label: string;
  detail: string;
}

/** Channels with credentials configured — shown in Mi Agente even at 0 traffic. */
export function configuredChannels(env: Env): ConfiguredChannel[] {
  const out: ConfiguredChannel[] = [];
  // WhatsApp OFICIAL (Cloud API de Meta, sin BSP). Basta el par phone id +
  // token: son las dos piezas sin las cuales el canal no puede ni recibir ni
  // responder. Sin esta rama, un bot conectado SOLO por Cloud API no mostraba
  // ningún canal de WhatsApp en Mi Agente aunque estuviera funcionando.
  if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
    out.push({ id: "whatsapp", label: "WhatsApp", detail: "Meta oficial" });
  }
  if (env.TWILIO_ACCOUNT_SID) {
    out.push({ id: "twilio", label: "WhatsApp", detail: "Twilio" });
  }
  if (env.TELEGRAM_BOT_TOKEN) {
    out.push({ id: "telegram", label: "Telegram", detail: "bot oficial" });
  }
  if (env.INSTAGRAM_ACCESS_TOKEN) {
    out.push({ id: "instagram", label: "Instagram", detail: "Meta oficial" });
  }
  if (env.META_PAGE_ACCESS_TOKEN) {
    out.push({ id: "messenger", label: "Messenger", detail: "Meta oficial" });
  }
  if (env.MANYCHAT_API_KEY) {
    out.push({ id: "manychat", label: "ManyChat", detail: "IG/FB vía ManyChat" });
  }
  return out;
}
