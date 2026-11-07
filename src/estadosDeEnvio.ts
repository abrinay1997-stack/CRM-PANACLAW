// «Entregado», «leído» y «no llegó» de WhatsApp Cloud, y de qué mensaje es cada
// respuesta citada o reacción.
//
// Hasta el 7-nov-2026 los recibos (`statuses[]`) se tiraban y el panel decía
// «Enviado» en cuanto el servidor de Meta contestaba 200, aunque el mensaje
// luego fallara. Ahora cada mensaje que sale lleva la marca `[WAID: <ids>]` (los
// ids que Meta le dio), y la tabla `wa_mensajes` guarda el estado de cada id.
//
// También guarda un extracto de cada mensaje que entra o sale: es lo que permite
// mostrar «en respuesta a: …» cuando el cliente cita un mensaje, y «reaccionó 👍
// a: …». No se crea con una migración aparte: se asegura sola la primera vez que
// se usa, y todo lo de aquí abajo falla en silencio —el bot nunca debe dejar de
// contestar por un recibo.

import type { Env } from "./env";

export type Estado = "enviado" | "entregado" | "leido" | "fallido";
export type DeQuien = "cliente" | "equipo" | "bot";

const ORDEN: Record<string, number> = { enviado: 1, entregado: 2, leido: 3 };

// ---- Las marcas que viajan dentro del texto guardado ---------------------------

export const marcaDeWaid = (ids: string[]): string => `[WAID: ${ids.join(",")}]`;

/** Los ids que Meta le dio a lo que salió. */
export function idsDeWaid(contenido: string): string[] {
  const m = contenido.match(/\[WAID: ([^\]\s]+)\]/);
  return m ? m[1].split(",").filter(Boolean) : [];
}

export const sinMarcaDeWaid = (texto: string): string => texto.replace(/\n?\[WAID: [^\]]*\]/g, "");

const limpioDeCorchetes = (s: string) => s.replace(/[[\]|\n\r]+/g, " ").replace(/\s+/g, " ").trim();

/** El extracto que se guarda de un mensaje: sin corchetes, que romperían las marcas. */
export const extractoDe = (texto: string, max = 120): string => {
  const limpio = limpioDeCorchetes(
    texto
      .replace(/\n?\[(ADJUNTO|ADJUNTO_FALLIDO|WAID|CITA|REACCION|IMAGE_URL|DOCUMENTO|ANUNCIO): [^\]]*\]/g, "")
      .replace(/^\[(REENVIADO|NOTA INTERNA)\] ?/, ""),
  );
  return limpio.length > max ? `${limpio.slice(0, max - 1)}…` : limpio;
};

export const marcaDeCita = (de: DeQuien, extracto: string): string => `[CITA: ${de} | ${limpioDeCorchetes(extracto)}]`;
export const marcaDeReaccion = (emoji: string, extracto: string): string =>
  `[REACCION: ${limpioDeCorchetes(emoji)} | ${limpioDeCorchetes(extracto)}]`;

export function citaDe(contenido: string): { de: DeQuien | null; extracto: string } | null {
  const m = contenido.match(/\[CITA: (cliente|equipo|bot|\?) \| ([^\]]*)\]/);
  return m ? { de: m[1] === "?" ? null : (m[1] as DeQuien), extracto: m[2] } : null;
}

export function reaccionDe(contenido: string): { emoji: string; extracto: string } | null {
  const m = contenido.match(/\[REACCION: ([^|\]]*) \| ([^\]]*)\]/);
  return m ? { emoji: m[1].trim(), extracto: m[2] } : null;
}

// ---- La tabla ------------------------------------------------------------------

const lista = new WeakSet<object>();

async function asegurarTabla(env: Env): Promise<void> {
  if (lista.has(env.DB as object)) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS wa_mensajes (
       wa_id TEXT PRIMARY KEY,
       conversation_id TEXT NOT NULL,
       de TEXT NOT NULL,
       extracto TEXT NOT NULL DEFAULT '',
       estado TEXT,
       detalle TEXT,
       creado INTEGER NOT NULL,
       actualizado INTEGER NOT NULL
     )`,
  ).run();
  lista.add(env.DB as object);
}

/** Anota mensajes (que entran o salen) con su id de WhatsApp. Nunca lanza. */
export async function registrarMensajes(
  env: Env,
  conversationId: string,
  ids: string[],
  de: DeQuien,
  extracto: string,
  estado: Estado | null = de === "cliente" ? null : "enviado",
  ahora = Date.now(),
): Promise<void> {
  if (!ids.length) return;
  try {
    await asegurarTabla(env);
    const stmt = env.DB.prepare(
      `INSERT INTO wa_mensajes (wa_id, conversation_id, de, extracto, estado, creado, actualizado)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wa_id) DO NOTHING`,
    );
    await env.DB.batch(ids.map((id) => stmt.bind(id, conversationId, de, extractoDe(extracto), estado, ahora, ahora)));
  } catch (e) {
    console.warn("[estados] no se pudo anotar:", e);
  }
}

/** Qué mensaje era el citado o reaccionado: de quién y qué decía. */
export async function buscarMensaje(env: Env, waId: string): Promise<{ de: DeQuien; extracto: string } | null> {
  try {
    await asegurarTabla(env);
    return (await env.DB.prepare("SELECT de, extracto FROM wa_mensajes WHERE wa_id = ?").bind(waId).first<{ de: DeQuien; extracto: string }>()) ?? null;
  } catch {
    return null;
  }
}

/** Lo que dice Meta cuando falla, en palabras del dueño. */
export function motivoDeFallo(codigo: number | undefined, titulo: string | undefined): string {
  if (codigo === 131047 || codigo === 131051) return "pasaron más de 24 horas desde su último mensaje";
  if (codigo === 131026) return "ese número no tiene WhatsApp o no pudo recibirlo";
  if (codigo === 131049) return "WhatsApp frenó el mensaje para cuidar la calidad de la cuenta";
  if (codigo === 130429 || codigo === 131056) return "se mandaron muchos mensajes seguidos";
  return titulo ? `WhatsApp dijo: ${titulo}` : "WhatsApp no lo entregó";
}

interface WaStatus {
  id?: string;
  status?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

/** Los recibos que trae un webhook de WhatsApp Cloud, guardados. Nunca lanza. */
export async function registrarEstados(env: Env, body: any, ahora = Date.now()): Promise<number> {
  const recibos: WaStatus[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) recibos.push(s);
    }
  }
  if (!recibos.length) return 0;
  let n = 0;
  try {
    await asegurarTabla(env);
    for (const r of recibos) {
      if (!r.id) continue;
      const nuevo: Estado | null =
        r.status === "sent" ? "enviado" : r.status === "delivered" ? "entregado" : r.status === "read" ? "leido" : r.status === "failed" ? "fallido" : null;
      if (!nuevo) continue;
      const detalle = nuevo === "fallido" ? motivoDeFallo(r.errors?.[0]?.code, r.errors?.[0]?.title) : null;
      const actual = await env.DB.prepare("SELECT estado FROM wa_mensajes WHERE wa_id = ?").bind(r.id).first<{ estado: string | null }>();
      if (!actual) continue; // no es un mensaje nuestro de los que seguimos
      // Los recibos llegan desordenados: «entregado» no pisa a «leído».
      if (nuevo !== "fallido" && (ORDEN[actual.estado ?? ""] ?? 0) >= ORDEN[nuevo]) continue;
      await env.DB.prepare("UPDATE wa_mensajes SET estado = ?, detalle = ?, actualizado = ? WHERE wa_id = ?")
        .bind(nuevo, detalle, ahora, r.id)
        .run();
      n++;
    }
  } catch (e) {
    console.warn("[estados] no se pudieron guardar los recibos:", e);
  }
  return n;
}

export interface EstadoDeMensaje {
  estado: Estado;
  detalle: string | null;
}

/** El estado de cada id, para pintar el hilo. */
export async function estadosDe(env: Env, ids: string[]): Promise<Map<string, EstadoDeMensaje>> {
  const out = new Map<string, EstadoDeMensaje>();
  if (!ids.length) return out;
  try {
    await asegurarTabla(env);
    const unicos = [...new Set(ids)].slice(0, 400);
    for (let i = 0; i < unicos.length; i += 80) {
      const grupo = unicos.slice(i, i + 80);
      const r = await env.DB.prepare(`SELECT wa_id, estado, detalle FROM wa_mensajes WHERE wa_id IN (${grupo.map(() => "?").join(",")})`)
        .bind(...grupo)
        .all<{ wa_id: string; estado: Estado | null; detalle: string | null }>();
      for (const f of r.results ?? []) if (f.estado) out.set(f.wa_id, { estado: f.estado, detalle: f.detalle });
    }
  } catch {
    /* sin tabla o sin base: el hilo se pinta sin recibos */
  }
  return out;
}

/** Un mensaje puede salir en varios trozos: manda el peor (si uno falló) o el menos avanzado. */
export function estadoResumen(ids: string[], estados: Map<string, EstadoDeMensaje>): EstadoDeMensaje | null {
  if (!ids.length) return null;
  const vistos = ids.map((id) => estados.get(id) ?? { estado: "enviado" as Estado, detalle: null });
  const fallo = vistos.find((v) => v.estado === "fallido");
  if (fallo) return fallo;
  return vistos.reduce((a, b) => (ORDEN[a.estado] <= ORDEN[b.estado] ? a : b));
}
