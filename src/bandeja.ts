// Qué conversaciones piden algo de una persona, y cuáles tienen mensajes sin leer.
//
// «Sin leer» es lo que el cliente escribió después de la última vez que alguien
// abrió la conversación en el panel (`metadata.leido`, sin migración).
// «Esperan» es más estricto, como en D'Casa: la tiene una persona (bot en pausa o
// ticket abierto) y lo último que se dijo fue del cliente. Lo que atiende el bot
// no cuenta: el bot ya contestó.

import { Db } from "./db/client";
import { cambiarMetadata } from "./takeover";

/** A partir de cuánto sin contestar se pinta en rojo. */
export const ESPERA_LARGA_MS = 15 * 60_000;

/** `json_extract` revienta con un JSON roto: se mira primero que sea válido. */
const LEIDO = "COALESCE(CASE WHEN json_valid(c.metadata) THEN CAST(json_extract(c.metadata, '$.leido') AS INTEGER) END, 0)";

const ULTIMO_DEL_CLIENTE = "COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND role = 'user'), 0)";

/** Verdadero si el cliente escribió algo que nadie ha abierto todavía. */
export const SQL_SIN_LEER = `(${ULTIMO_DEL_CLIENTE} > ${LEIDO})`;

/** La tiene una persona y lo último fue del cliente. Necesita `?` con la hora de ahora. */
export const SQL_ESPERAN = `(
  ((c.paused_until IS NOT NULL AND c.paused_until > ?)
    OR EXISTS (SELECT 1 FROM tickets t WHERE t.conversation_id = c.id AND t.status != 'resolved'))
  AND (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) = 'user'
)`;

/** Se abrió la conversación: lo que haya hasta ahora queda leído. */
export async function marcarLeida(db: Db, conversationId: string, ahora = Date.now()): Promise<void> {
  // Solo se escribe si hay algo sin leer: el hilo abierto se refresca cada 5 s y
  // no hace falta una escritura en cada vuelta.
  const hay = await db.first<{ x: number }>(`SELECT 1 as x FROM conversations c WHERE c.id = ? AND ${SQL_SIN_LEER}`, [conversationId]);
  if (!hay) return;
  await cambiarMetadata(db, conversationId, { leido: ahora });
}

/** «hace 5 min», «hace 3 h»: cuánto lleva esperando. */
export function esperaLegible(desde: number, ahora = Date.now()): string {
  const min = Math.max(0, Math.floor((ahora - desde) / 60_000));
  if (min < 1) return "ahora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}
