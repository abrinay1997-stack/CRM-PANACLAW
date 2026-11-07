// Mandarle un archivo al cliente desde el panel: una cotización en PDF, una
// foto, un audio. Como en D'Casa, donde el equipo adjunta desde la ficha.
//
// Por canal:
//   - WhatsApp oficial (Cloud API): se sube el archivo a Meta (/media) y se
//     manda por su id. No hace falta una URL pública.
//   - Telegram: sendPhoto / sendDocument con los bytes.
//   - El resto (WhatsApp por QR, Instagram, Messenger) todavía no: el puente
//     del QR solo manda texto. El panel no muestra el botón ahí.
import type { Env } from "../env";
import { enviarDocumento, enviarFoto } from "../owner/telegram";

const GRAPH_VERSION = "v26.0";

export interface ArchivoParaEnviar {
  bytes: Uint8Array;
  mime: string;
  nombre: string;
}

/** Los canales a los que el panel puede mandar un archivo. */
export function aceptaArchivos(channel: string): boolean {
  return channel === "whatsapp" || channel === "telegram";
}

/** Lo que WhatsApp manda como foto; el resto va como documento (o audio). */
const FOTO_WA = /^image\/(jpeg|png)$/;
const AUDIO_WA = /^audio\/(aac|amr|mpeg|mp4|ogg)$/;
const VIDEO_WA = /^video\/(mp4|3gpp)$/;

/** Lanza un error con el motivo, en palabras del dueño, si no salió. */
export async function enviarArchivo(
  env: Env,
  channel: string,
  channelUserId: string,
  archivo: ArchivoParaEnviar,
  leyenda: string,
): Promise<void> {
  if (channel === "whatsapp") return enviarPorWhatsApp(env, channelUserId, archivo, leyenda);
  if (channel === "telegram") {
    const foto = FOTO_WA.test(archivo.mime);
    const id = foto
      ? await enviarFoto(env, channelUserId, archivo.bytes, archivo.mime, leyenda || undefined)
      : await enviarDocumento(env, channelUserId, archivo.bytes, archivo.mime, archivo.nombre, leyenda || undefined);
    if (id === null) throw new Error("Telegram no lo aceptó. Revisa que el cliente no haya bloqueado al bot.");
    return;
  }
  throw new Error("Este canal todavía no acepta archivos desde el panel.");
}

async function enviarPorWhatsApp(env: Env, to: string, archivo: ArchivoParaEnviar, leyenda: string): Promise<void> {
  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error("Falta conectar WhatsApp (WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN).");
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}`;

  // 1) Subir el archivo a Meta.
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", archivo.mime);
  form.append("file", new Blob([archivo.bytes], { type: archivo.mime }), archivo.nombre);
  const subida = await fetch(`${base}/media`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const subido = (await subida.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!subida.ok || !subido?.id) throw new Error(motivoDeMeta(subido?.error?.message, subida.status));

  // 2) Mandarlo.
  const tipo = FOTO_WA.test(archivo.mime) ? "image" : AUDIO_WA.test(archivo.mime) ? "audio" : VIDEO_WA.test(archivo.mime) ? "video" : "document";
  const media: Record<string, string> = { id: subido.id };
  // WhatsApp no deja texto en un audio: la leyenda sale en un mensaje aparte.
  if (leyenda && tipo !== "audio") media.caption = leyenda.slice(0, 1024);
  if (tipo === "document") media.filename = archivo.nombre;
  const envio = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: tipo, [tipo]: media }),
  });
  if (!envio.ok) {
    const cuerpo = (await envio.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(motivoDeMeta(cuerpo?.error?.message, envio.status));
  }
  if (leyenda && tipo === "audio") {
    await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: leyenda } }),
    });
  }
}

/**
 * El motivo de Meta, con la causa más común dicha claro: pasadas 24 horas del
 * último mensaje del cliente, WhatsApp no deja escribirle primero.
 */
export function motivoDeMeta(mensaje: string | undefined, status: number): string {
  const m = mensaje ?? `error ${status}`;
  if (/re-engagement|24 hours|window/i.test(m)) {
    return "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no deja escribirle primero.";
  }
  return `WhatsApp no lo aceptó: ${m}`;
}
