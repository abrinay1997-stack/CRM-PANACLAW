// Lo que se hace con un mensaje de WhatsApp Cloud antes de dárselo al agente:
// anotar su huella (para que otro mensaje lo pueda citar), convertir «respondió a
// tal mensaje» en una marca que el panel y el bot entienden, y registrar las
// reacciones, que no se contestan.

import type { Env } from "../env";
import type { IncomingMessage } from "./shared";
import { Db } from "../db/client";
import { ConversationsRepo } from "../db/conversations";
import { MessagesRepo } from "../db/messages";
import { buscarMensaje, extractoDe, marcaDeCita, marcaDeReaccion, registrarMensajes } from "../estadosDeEnvio";

/**
 * Devuelve `false` si el mensaje no hay que dárselo al agente (una reacción: se
 * anota en la conversación y ya). Modifica `msg.text` si cita algo.
 */
export async function prepararEntrante(env: Env, msg: IncomingMessage): Promise<boolean> {
  if (!env.DB) return true;
  const convId = `${msg.channel}:${msg.channelUserId}`;

  if (msg.reaccion) {
    const citado = await buscarMensaje(env, msg.reaccion.mensajeId);
    const db = new Db(env.DB);
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate(msg.channel, msg.channelUserId, msg.displayName);
    // Se guarda como algo que dijo el cliente, para que quede en el hilo y cuente como sin leer.
    await new MessagesRepo(db).append(conv.id, "user", marcaDeReaccion(msg.reaccion.emoji, citado?.extracto ?? ""));
    await convs.touchLastMessage(conv.id);
    return false;
  }

  if (msg.waId) {
    const resumen = msg.text ? msg.text : msg.imageUrl ? "Foto" : msg.videoUrl ? "Video" : msg.audioUrl ? "Nota de voz" : "";
    await registrarMensajes(env, convId, [msg.waId], "cliente", extractoDe(resumen) || "(archivo)", null);
  }

  if (msg.citaDe) {
    const citado = await buscarMensaje(env, msg.citaDe);
    const marca = marcaDeCita(citado?.de ?? ("?" as never), citado?.extracto ?? "");
    msg.text = msg.text ? `${msg.text}\n${marca}` : marca;
  }
  return true;
}
