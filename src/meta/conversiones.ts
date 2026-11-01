// Avisarle a Meta quién de los que llegaron por un anuncio de WhatsApp se volvió
// lead y quién compró (Conversions API for Business Messaging).
//
// Sin esto Meta solo ve «alguien empezó un chat», y optimiza los anuncios para
// traer más gente que escribe, no gente que compra. Con los anuncios de octubre
// de 2026 llegaron, por ejemplo, alguien que tocó el anuncio sin querer y un
// jubilado que buscaba un préstamo.
//
// Cómo funciona:
//   1. El primer mensaje que llega desde un anuncio trae `referral.ctwa_clid`,
//      el identificador de ESE clic. Se guarda en la conversación (`anuncio`
//      en conversations.metadata), con el id de la cuenta de WhatsApp Business
//      (entry.id del webhook).
//   2. Cuando el bot anota un lead (captureLead) se manda «LeadSubmitted».
//      Cuando el dueño marca el lead como vendido, «Purchase» con el monto.
//   3. Una vez por conversación y evento (tabla eventos_meta), con event_id
//      para que Meta tampoco lo cuente dos veces, y solo dentro de los 7 días
//      del clic: después Meta ya no lo atribuye al anuncio.
//
// Solo se manda el identificador del clic y el de la cuenta: ni el nombre ni el
// teléfono del cliente. Nunca rompe lo que lo llama: el resultado se anota y el
// panel lo enseña (Configuración → Publicidad en Meta).
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";

const GRAPH = "https://graph.facebook.com/v26.0";
const DIA = 24 * 60 * 60 * 1000;
/** Meta atribuye el evento al anuncio hasta 7 días después del clic. */
export const VENTANA_DE_ATRIBUCION_MS = 7 * DIA;
/** PanaClaw cobra en dólares (Panamá). */
const MONEDA = "USD";
/** Meta no puede frenar la respuesta al cliente: si tarda, se corta y queda como fallo. */
const ESPERA_MAXIMA_MS = 8000;

export type EventoMeta = "LeadSubmitted" | "Purchase";

export interface ClicDeAnuncio {
  ctwa_clid: string;
  /** El id del anuncio en Meta, si vino. */
  source_id?: string;
  /** La cuenta de WhatsApp Business que recibió el mensaje (entry.id). */
  waba_id?: string;
  titular?: string;
  /** Cuándo llegó el primer mensaje del clic. */
  at: number;
}

export interface ResultadoMeta {
  estado: "enviado" | "omitido" | "fallo";
  detalle: string;
}

/** Lo que trae el webhook cuando el mensaje viene de un anuncio. */
export interface AnuncioEntrante {
  ctwaClid: string;
  sourceId?: string;
  wabaId?: string;
  titular?: string;
}

function leerMetadata(texto: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(texto ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Guarda el clic en la conversación. Si la persona vuelve por otro anuncio, el
 * nuevo clic reemplaza al anterior: el que cuenta es el último.
 */
export async function guardarClic(env: Env, conversationId: string, a: AnuncioEntrante, ahora = Date.now()): Promise<void> {
  const db = new Db(env.DB);
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [conversationId]);
  const meta = leerMetadata(fila?.metadata);
  const previo = meta.anuncio as ClicDeAnuncio | undefined;
  if (previo?.ctwa_clid === a.ctwaClid) return;
  const clic: ClicDeAnuncio = {
    ctwa_clid: a.ctwaClid,
    ...(a.sourceId ? { source_id: a.sourceId } : {}),
    ...(a.wabaId ? { waba_id: a.wabaId } : {}),
    ...(a.titular ? { titular: a.titular.slice(0, 120) } : {}),
    at: ahora,
  };
  meta.anuncio = clic;
  await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify(meta), conversationId]);
  // La cuenta de WhatsApp Business, para encontrar el conjunto de datos sin
  // pedírsela al dueño.
  if (a.wabaId) {
    const repo = new SettingsRepo(db);
    if ((await repo.get(SETTING_KEYS.metaWabaId)) !== a.wabaId) await repo.set(SETTING_KEYS.metaWabaId, a.wabaId);
  }
}

export async function clicDe(env: Env, conversationId: string): Promise<ClicDeAnuncio | null> {
  const fila = await new Db(env.DB).first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [
    conversationId,
  ]);
  const clic = leerMetadata(fila?.metadata).anuncio as ClicDeAnuncio | undefined;
  return clic?.ctwa_clid ? clic : null;
}

/** El clic más reciente de cualquier conversación (para el botón de prueba). */
export async function ultimoClic(env: Env): Promise<ClicDeAnuncio | null> {
  const filas = await new Db(env.DB).all<{ metadata: string }>(
    "SELECT metadata FROM conversations WHERE instr(metadata, '\"ctwa_clid\"') > 0 ORDER BY last_message_at DESC LIMIT 1",
  );
  const clic = leerMetadata(filas[0]?.metadata).anuncio as ClicDeAnuncio | undefined;
  return clic?.ctwa_clid ? clic : null;
}

function errorDeMeta(json: unknown, status: number): string {
  const e = (json as { error?: { message?: string; error_user_msg?: string } } | null)?.error;
  return e?.error_user_msg || e?.message || `error ${status}`;
}

/**
 * El conjunto de datos (dataset) donde Meta recibe los eventos de esta cuenta
 * de WhatsApp. El que puso el dueño en el panel manda; si no hay, se pide a
 * Meta (y se crea si la cuenta no tiene uno) y se guarda.
 */
async function conjuntoDeDatos(env: Env, wabaId: string, token: string): Promise<{ id: string } | { error: string }> {
  const repo = new SettingsRepo(new Db(env.DB));
  const guardado = (await repo.get(SETTING_KEYS.metaDatasetId))?.trim();
  if (guardado) return { id: guardado };

  const headers = { Authorization: `Bearer ${token}` };
  const idDe = (j: any): string | undefined => j?.id ?? j?.dataset_id ?? j?.data?.[0]?.dataset_id ?? j?.data?.[0]?.id;
  const consulta = await fetch(`${GRAPH}/${wabaId}/dataset`, { headers, signal: AbortSignal.timeout(ESPERA_MAXIMA_MS) });
  const jc = await consulta.json().catch(() => null);
  let id = consulta.ok ? idDe(jc) : undefined;
  if (!id) {
    const alta = await fetch(`${GRAPH}/${wabaId}/dataset`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
    });
    const ja = await alta.json().catch(() => null);
    if (!alta.ok || !idDe(ja)) {
      return { error: `No se pudo obtener el conjunto de datos de Meta: ${errorDeMeta(alta.ok ? jc : ja, alta.status)}` };
    }
    id = idDe(ja)!;
  }
  await repo.set(SETTING_KEYS.metaDatasetId, String(id));
  return { id: String(id) };
}

async function anotar(
  env: Env,
  conversationId: string,
  evento: string,
  r: ResultadoMeta,
  valor: number | null,
  ctwaClid: string | null,
): Promise<void> {
  const db = new Db(env.DB);
  const ahora = Date.now();
  if (r.estado !== "omitido") {
    await db.run(
      `INSERT INTO eventos_meta (conversation_id, evento, ctwa_clid, estado, detalle, valor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, evento) DO UPDATE SET ctwa_clid = excluded.ctwa_clid, estado = excluded.estado,
         detalle = excluded.detalle, valor = excluded.valor, created_at = excluded.created_at`,
      [conversationId, evento, ctwaClid, r.estado, r.detalle.slice(0, 500), valor, ahora],
    );
  }
  await new SettingsRepo(db).set(
    SETTING_KEYS.metaUltimoEnvio,
    JSON.stringify({ evento, conversationId, ...r, at: ahora }),
  );
}

/**
 * Le avisa a Meta. `prueba` manda el evento con el código de prueba del
 * Administrador de eventos: se ve ahí y no cuenta para los anuncios.
 */
export async function avisarAMeta(
  env: Env,
  conversationId: string,
  evento: EventoMeta,
  opts: { valor?: number; prueba?: { codigo: string; clic: ClicDeAnuncio } } = {},
): Promise<ResultadoMeta> {
  try {
    const clic = opts.prueba?.clic ?? (await clicDe(env, conversationId));
    if (!clic) return { estado: "omitido", detalle: "La conversación no vino de un anuncio de WhatsApp." };
    if (!opts.prueba && Date.now() - clic.at > VENTANA_DE_ATRIBUCION_MS) {
      return { estado: "omitido", detalle: "Pasaron más de 7 días desde el clic: Meta ya no lo atribuye al anuncio." };
    }
    if (evento === "Purchase" && !(opts.valor && opts.valor > 0)) {
      return { estado: "omitido", detalle: "Una venta necesita su monto." };
    }
    if (!opts.prueba) {
      // Una vez por clic: si la persona vuelve por otro anuncio, es otro clic y
      // cuenta de nuevo (hallazgo de Codex).
      const ya = await new Db(env.DB).first<{ estado: string; ctwa_clid: string | null }>(
        "SELECT estado, ctwa_clid FROM eventos_meta WHERE conversation_id = ? AND evento = ?",
        [conversationId, evento],
      );
      if (ya?.estado === "enviado" && ya.ctwa_clid === clic.ctwa_clid) {
        return { estado: "omitido", detalle: "Ya se le había avisado a Meta." };
      }
    }

    const token = env.WHATSAPP_ACCESS_TOKEN;
    const wabaId = clic.waba_id ?? (await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.metaWabaId)) ?? undefined;
    let r: ResultadoMeta;
    if (!token) r = { estado: "fallo", detalle: "Falta WHATSAPP_ACCESS_TOKEN." };
    else if (!wabaId) r = { estado: "fallo", detalle: "No se sabe la cuenta de WhatsApp Business del anuncio." };
    else {
      const dataset = await conjuntoDeDatos(env, wabaId, token);
      if ("error" in dataset) r = { estado: "fallo", detalle: dataset.error };
      else {
        const res = await fetch(`${GRAPH}/${dataset.id}/events`, {
          method: "POST",
          signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            data: [
              {
                event_name: evento,
                event_time: Math.floor(Date.now() / 1000),
                // Con el clic y no con la conversación: su id lleva el teléfono.
                event_id: `${clic.ctwa_clid}:${evento}`,
                action_source: "business_messaging",
                messaging_channel: "whatsapp",
                user_data: { whatsapp_business_account_id: wabaId, ctwa_clid: clic.ctwa_clid },
                ...(evento === "Purchase" ? { custom_data: { currency: MONEDA, value: opts.valor } } : {}),
              },
            ],
            ...(opts.prueba ? { test_event_code: opts.prueba.codigo } : {}),
          }),
        });
        const json = (await res.json().catch(() => null)) as { events_received?: number } | null;
        r =
          res.ok && (json?.events_received ?? 0) > 0
            ? { estado: "enviado", detalle: opts.prueba ? "Evento de prueba recibido por Meta." : "Meta lo recibió." }
            : { estado: "fallo", detalle: `Meta no lo aceptó: ${errorDeMeta(json, res.status)}` };
      }
    }
    await anotar(env, conversationId, opts.prueba ? `prueba-${evento}` : evento, r, opts.valor ?? null, clic.ctwa_clid);
    if (r.estado === "fallo") console.warn(`[meta] ${evento} ${conversationId}: ${r.detalle}`);
    return r;
  } catch (e) {
    const r: ResultadoMeta = { estado: "fallo", detalle: `Error al avisar a Meta: ${e instanceof Error ? e.message : String(e)}` };
    console.warn(`[meta] ${evento} ${conversationId}:`, e);
    await anotar(env, conversationId, evento, r, opts.valor ?? null, null).catch(() => {});
    return r;
  }
}

/**
 * El monto que escribió el dueño, como número. «$1,200» son mil doscientos
 * (antes salía 1.2: hallazgo de Codex); «1.200,50» y «1,200.50» también se
 * entienden. null si no hay un monto válido.
 */
export function montoDe(texto: string | null | undefined): number | null {
  let t = (texto ?? "").replace(/[^0-9.,]/g, "");
  if (!t) return null;
  const ultimo = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  const decimales = ultimo >= 0 ? t.length - ultimo - 1 : 0;
  // El último separador es decimal solo si le siguen 1 o 2 cifras; si le siguen
  // 3, es de miles («1,200», «1.200»).
  if (ultimo >= 0 && decimales > 0 && decimales <= 2) {
    t = `${t.slice(0, ultimo).replace(/[.,]/g, "")}.${t.slice(ultimo + 1)}`;
  } else {
    t = t.replace(/[.,]/g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Al borrar una conversación, sus avisos a Meta se van con ella. */
export async function borrarEventosDe(env: Env, conversationId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM eventos_meta WHERE conversation_id = ?").bind(conversationId).run();
}

export interface EstadoMeta {
  wabaId: string | null;
  datasetId: string | null;
  clics30d: number;
  leads30d: number;
  ventas30d: number;
  fallos30d: number;
  ultimo: (ResultadoMeta & { evento: string; at: number }) | null;
}

/** Lo que enseña el panel. */
export async function estadoMeta(env: Env): Promise<EstadoMeta> {
  const db = new Db(env.DB);
  const repo = new SettingsRepo(db);
  const desde = Date.now() - 30 * DIA;
  const cuenta = async (sql: string, params: unknown[]) => (await db.first<{ n: number }>(sql, params))?.n ?? 0;
  let ultimo: EstadoMeta["ultimo"] = null;
  try {
    ultimo = JSON.parse((await repo.get(SETTING_KEYS.metaUltimoEnvio)) ?? "null");
  } catch {
    /* nada */
  }
  return {
    wabaId: (await repo.get(SETTING_KEYS.metaWabaId)) ?? null,
    datasetId: (await repo.get(SETTING_KEYS.metaDatasetId))?.trim() || null,
    clics30d: await cuenta(
      "SELECT COUNT(*) AS n FROM conversations WHERE instr(metadata, '\"ctwa_clid\"') > 0 AND last_message_at > ?",
      [desde],
    ),
    leads30d: await cuenta(
      "SELECT COUNT(*) AS n FROM eventos_meta WHERE evento = 'LeadSubmitted' AND estado = 'enviado' AND created_at > ?",
      [desde],
    ),
    ventas30d: await cuenta(
      "SELECT COUNT(*) AS n FROM eventos_meta WHERE evento = 'Purchase' AND estado = 'enviado' AND created_at > ?",
      [desde],
    ),
    fallos30d: await cuenta("SELECT COUNT(*) AS n FROM eventos_meta WHERE estado = 'fallo' AND created_at > ?", [desde]),
    ultimo,
  };
}
