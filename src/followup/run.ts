/**
 * Seguimiento a los clientes que dejaron de contestar.
 *
 *   1. A las 5 horas sin respuesta.
 *   2. Si sigue sin contestar, 3 días después.
 *   3. Si sigue sin contestar, 7 días después. Y ahí se para.
 *
 * El calendario es el de Baby Caleb (23-sep-2026). Hasta el 25-sep-2026
 * PanaClaw mandaba UN solo seguimiento de por vida, entre 3 y 20 horas, y solo
 * a quien el Analista marcaba como venta abierta: el que se enfriaba un día
 * después ya no recibía nada. Ahora los tres CRMs siguen la misma regla:
 *
 *  • SOLO en horario laboral (src/hours.ts, editable en el panel). Es el único
 *    mensaje que el bot manda sin que nadie le haya escrito. Un paso que se
 *    vence de noche sale a primera hora del siguiente día hábil.
 *  • Lo redacta la IA leyendo la conversación, con el trato que ya se usó.
 *    Si por la conversación un seguimiento estaría fuera de lugar (el cliente
 *    quedó en escribir él, una persona tomó el caso, número equivocado),
 *    contesta NO_ENVIAR y el ciclo se cierra.
 *  • Nunca a quien dijo que no le interesa: una sola vez que lo diga basta.
 *  • Nunca a una conversación pausada (una persona la tomó) ni con un ticket
 *    abierto (ya hay alguien del equipo en eso).
 *
 * Cada vez que el cliente contesta empieza un ciclo nuevo (el `ciclo` es la hora
 * de su último mensaje). La tabla `seguimientos` es el claim: un paso de un
 * ciclo sale una sola vez aunque dos corridas se crucen.
 *
 * La ventana de 24 h: WhatsApp oficial, Messenger e Instagram no dejan escribir
 * primero pasadas 24 h del último mensaje del cliente. En esos canales solo sale
 * lo que cabe en la ventana; los de 3 y 7 días salen por WhatsApp por QR y
 * Telegram.
 */
import { generateText } from "ai";
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { ConversationsRepo } from "../db/conversations";
import { resolveAgentConfig, loadLlmOverrides } from "../settings-loader";
import { createModel } from "../llm/provider";
import { recordAiUsage, usageFromSdk } from "../db/aiUsage";
import { pickAdapter } from "../replies/sender";
import { isWithinBusinessHours, localTime, formatBusinessHours } from "../hours";
import type { ChannelId } from "../channels/shared";

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

/** Cuánto se espera antes de cada paso, contado desde el mensaje anterior del negocio. */
export const PASOS = [
  { espera: 5 * HORA, guia: "Es el primer seguimiento, unas horas después. Retoma con naturalidad lo último que hablaron y pregúntale si le quedó alguna duda o si quiere avanzar." },
  { espera: 3 * DIA, guia: "Es el segundo seguimiento, tres días después. Un recordatorio breve y amable: ofrécele ayuda concreta con lo que estaba buscando." },
  { espera: 7 * DIA, guia: "Es el último seguimiento, una semana después. Un cierre cordial que deje la puerta abierta, sin ninguna presión. No vuelvas a preguntar lo mismo de los mensajes anteriores." },
] as const;

/** Canales con la ventana de 24 h de Meta/WhatsApp. */
const CON_VENTANA = new Set(["whatsapp", "messenger", "instagram", "twilio", "manychat"]);
const VENTANA_MS = 23 * HORA; // margen antes de que cierre

/** Canales a los que nunca se les escribe primero. Instagram oficial está apagado. */
const SIN_SEGUIMIENTO = new Set(["instagram"]);

/** La respuesta del modelo cuando un seguimiento estaría fuera de lugar. */
export const NO_ENVIAR = "NO_ENVIAR";

/**
 * ¿El cliente dijo que no le interesa, que ya compró o que no le escriban? Una
 * sola vez basta: no se le vuelve a escribir nunca. Conservador a propósito —
 * un "no, gracias" también cuenta: mejor un seguimiento de menos que uno que
 * moleste. (De Baby Caleb.)
 */
export function noQuiereSeguimiento(texto: string): boolean {
  const t = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  // Sin \b al final: "interesad" tiene que cubrir interesada e interesado.
  return /\b(no (me )?interes|ya no (me )?interes|no estoy interesad|sin interes|no,? gracias|no me (escriba|escriban|contacte|contacten|moleste|molesten)|dej(e|en) de (escribir|mandar)|no (me )?(vuelva|vuelvan) a escribir|no quiero (nada|mas|recibir)|ya (lo )?compre|ya (lo )?consegui|ya no (lo |los |las )?necesito|no necesito nada|borr(e|en) mi numero)/.test(t);
}

export interface Pendiente {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  ciclo: number;
  paso: number;
}

interface Fila {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  metadata: string | null;
  last_user_at: number | null;
  last_bot_at: number | null;
}

/** Las conversaciones a las que les toca un paso ahora mismo. */
export async function pendientes(env: Env, now: number, limite: number): Promise<Pendiente[]> {
  const db = new Db(env.DB);
  const filas = await db.all<Fila>(
    `SELECT * FROM (
       SELECT c.id, c.channel, c.channel_user_id, c.display_name, c.metadata,
         (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at,
         (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('assistant', 'owner')) AS last_bot_at
       FROM conversations c
       WHERE (c.paused_until IS NULL OR c.paused_until < ?)
         AND c.open_ticket_id IS NULL
         AND c.last_message_at >= ?
     )
     WHERE last_user_at IS NOT NULL AND last_bot_at IS NOT NULL AND last_bot_at >= last_user_at
     ORDER BY last_bot_at ASC
     LIMIT 200`,
    // Nada de lo que lleve más de 12 días quieto: el último paso sale a los 10.
    [now, now - 12 * DIA],
  );

  const salida: Pendiente[] = [];
  for (const f of filas) {
    if (salida.length >= limite) break;
    if (SIN_SEGUIMIENTO.has(f.channel)) continue;
    try {
      if (JSON.parse(f.metadata ?? "{}")?.sin_seguimiento) continue;
    } catch {
      /* metadata vieja o vacía: sigue */
    }
    const ciclo = f.last_user_at!;
    const hechos = await db.all<{ paso: number; enviado_en: number }>(
      "SELECT paso, enviado_en FROM seguimientos WHERE conversation_id = ? AND ciclo = ? ORDER BY paso",
      [f.id, ciclo],
    );
    const paso = hechos.length;
    if (paso >= PASOS.length) continue;
    const desde = paso === 0 ? f.last_bot_at! : hechos[hechos.length - 1].enviado_en;
    if (now - desde < PASOS[paso].espera) continue;
    if (CON_VENTANA.has(f.channel) && now - ciclo > VENTANA_MS) continue;
    salida.push({
      id: f.id,
      channel: f.channel,
      channel_user_id: f.channel_user_id,
      display_name: f.display_name,
      ciclo,
      paso,
    });
  }
  return salida;
}

export interface RunFollowupsResult {
  sent: number;
  skipped: number;
  errors: number;
  /** true = no se hizo nada porque el negocio está cerrado a esta hora. */
  outsideHours?: boolean;
}

/** Quién dijo cada cosa, como lo lee el modelo. */
const QUIEN: Record<string, string> = { user: "Cliente", assistant: "Tú", owner: "Equipo (una persona)" };

export async function runFollowups(
  env: Env,
  opts: { now?: number; limit?: number; dailyCap?: number } = {},
): Promise<RunFollowupsResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;
  const dailyCap = opts.dailyCap ?? 40;
  const nada: RunFollowupsResult = { sent: 0, skipped: 0, errors: 0 };

  // Respeta la pausa global del bot (el dueño lo apagó a propósito).
  const cfg = await resolveAgentConfig(env, []);
  if (cfg.botPaused) return nada;

  // Fuera de horario no se toca a nadie. Va ANTES de elegir: un paso vencido
  // de noche sigue ahí por la mañana, y ninguna corrida nocturna gasta su claim.
  if (!isWithinBusinessHours(new Date(now), cfg.timezone, cfg.businessHours)) {
    return { ...nada, outsideHours: true };
  }

  const db = new Db(env.DB);
  const hoy =
    (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM seguimientos WHERE enviado_en > ?", [now - DIA]))?.n ?? 0;
  if (hoy >= dailyCap) return nada;

  const lista = await pendientes(env, now, Math.min(limit, dailyCap - hoy));
  if (lista.length === 0) return nada;

  const msgs = new MessagesRepo(db);
  const convs = new ConversationsRepo(db);
  const { model, modelId } = createModel(env, "fast", await loadLlmOverrides(env));
  const reloj = localTime(new Date(now), cfg.timezone);
  const saludo = reloj.minuteOfDay < 12 * 60 ? "Buenos días" : "Buenas tardes";
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const p of lista) {
    // ¿Dijo alguna vez que no le interesa? Se marca para siempre y no se escribe.
    const suyos = await db.all<{ content: string }>(
      "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 200",
      [p.id],
    );
    if (suyos.some((m) => noQuiereSeguimiento(m.content))) {
      await marcarSinSeguimiento(db, p.id);
      skipped++;
      continue;
    }

    // Claim antes de redactar y enviar: dos corridas cruzadas no mandan el
    // mismo paso dos veces.
    const claim = await db.run(
      "INSERT OR IGNORE INTO seguimientos (conversation_id, ciclo, paso, enviado_en) VALUES (?, ?, ?, ?)",
      [p.id, p.ciclo, p.paso, now],
    );
    if ((claim.meta.changes ?? 0) === 0) {
      skipped++;
      continue;
    }

    try {
      const historia = await msgs.lastN(p.id, 12);
      const transcript = historia
        .map((m) => `${QUIEN[m.role] ?? m.role}: ${m.content.slice(0, 400)}`)
        .join("\n");

      const result = await generateText({
        model,
        prompt: `Eres ${cfg.botName || env.BOT_NAME}, respondiendo chats de ${env.BUSINESS_NAME} en primera persona. Le escribes a un cliente que dejó de responder.

Trato: el mismo que usaste en la conversación. Tono: ${cfg.tone || "cercano y profesional"}. Idioma: ${env.BOT_LANGUAGE || "es"}.
Son las ${reloj.clock} donde está el negocio: si saludas, usa "${saludo}".
${p.display_name ? `El cliente aparece como "${p.display_name}" (úsalo solo si parece un nombre de persona).` : ""}

${PASOS[p.paso].guia}

La conversación hasta ahora (lo más reciente al final):
${transcript}

Reglas:
- UN solo mensaje, máximo 2 o 3 líneas. Retoma algo concreto de la conversación, no un mensaje genérico.
- No des precios, cifras ni plazos que no estén ya en la conversación. Nada de descuentos.
- No repitas enlaces que ya se enviaron. Sin emojis. No digas que es un "seguimiento" ni que eres un bot.
- Si por la conversación un mensaje ahora estaría fuera de lugar —el cliente quedó en escribir él, ya lo está atendiendo una persona del equipo, la conversación quedó cerrada, no le interesa, era un número equivocado o no era un cliente— responde exactamente ${NO_ENVIAR}.

Responde SOLO con el mensaje (o ${NO_ENVIAR}), sin comillas ni explicación.`,
      });

      await recordAiUsage(db, {
        source: "followup",
        conversationId: p.id,
        model: modelId,
        usage: usageFromSdk(result.totalUsage),
      });

      const texto = result.text.trim();
      if (!texto) throw new Error("el modelo devolvió un seguimiento vacío");
      if (texto.includes(NO_ENVIAR)) {
        // El modelo leyó que no toca: se cierran los pasos que quedaban de
        // este ciclo. Si el cliente vuelve a escribir, empieza uno nuevo.
        for (let paso = p.paso + 1; paso < PASOS.length; paso++) {
          await db.run(
            "INSERT OR IGNORE INTO seguimientos (conversation_id, ciclo, paso, enviado_en) VALUES (?, ?, ?, ?)",
            [p.id, p.ciclo, paso, now],
          );
        }
        skipped++;
        continue;
      }

      // Mismo `now` que el claim y que touchLastMessage: los tres son el mismo
      // hecho, y con relojes distintos la Bandeja lo podía mostrar desordenado.
      await msgs.append(p.id, "assistant", texto, { modelUsed: `seguimiento-${p.paso + 1}`, createdAt: now });
      await convs.touchLastMessage(p.id, now);
      await pickAdapter(p.channel as ChannelId).sendReply(
        { channel: p.channel as ChannelId, channelUserId: p.channel_user_id, chunks: [texto], interChunkDelayMs: 0 },
        env,
      );
      sent++;
    } catch (e) {
      // El claim se queda: mejor un seguimiento perdido que uno repetido.
      errors++;
      console.error(`[seguimiento] falló ${p.id} paso ${p.paso + 1}:`, e);
    }
  }

  if (sent > 0 || errors > 0) {
    console.log(
      `[seguimiento] enviados=${sent} saltados=${skipped} errores=${errors} ` +
        `(horario ${formatBusinessHours(cfg.businessHours)} ${cfg.timezone})`,
    );
  }
  return { sent, skipped, errors };
}

async function marcarSinSeguimiento(db: Db, convId: string): Promise<void> {
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [convId]);
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fila?.metadata ?? "{}") ?? {};
  } catch {
    meta = {};
  }
  meta.sin_seguimiento = true;
  await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify(meta), convId]);
}
