// Las fotos, notas de voz y documentos que manda el cliente, guardados para que
// el dueño los vea y los escuche en el panel.
//
// Hasta el 28-oct-2026 solo los veía por Telegram. En el panel quedaba un
// [IMAGE_URL: …] que vencía a los 10 minutos, y de una nota de voz solo el texto
// transcrito, sin forma de escucharla. Ahora el archivo se guarda en R2 en
// cuanto llega, y el mensaje lleva una marca [ADJUNTO: <id>] que el panel
// convierte en la foto, el reproductor o el documento.
//
// Guardar es un extra, nunca la ruta crítica: si falla, el bot contesta igual
// y el mensaje se queda sin marca.

import type { Env } from "../env";
import { MEDIA_MAXIMA } from "./almacen";
import { tipoDeImagen } from "./vision";

export type TipoAdjunto = "imagen" | "audio" | "video" | "documento";

export interface Adjunto {
  id: string;
  conversation_id: string;
  tipo: TipoAdjunto;
  mime: string;
  nombre: string | null;
  r2_key: string;
  bytes: number;
  created_at: number;
}

const FOTOS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Lo único que se abre dentro del panel. Un documento del cliente es contenido
 * de un extraño: un .html abierto en el dominio del panel correría con la
 * sesión del dueño. Todo lo demás se descarga, y además va con CSP sandbox.
 */
const SE_ABRE_EN_EL_PANEL = /^(image\/(jpeg|png|gif|webp)|audio\/[\w.+-]+|video\/(mp4|webm|quicktime|3gpp)|application\/pdf)$/;

/** Un video de celular pesa más que una foto; WhatsApp deja mandar hasta 16 MB. */
export const VIDEO_MAXIMO = 16 * 1024 * 1024;

/** Cuánto deja guardar el panel de cada tipo. */
export const maximoDe = (tipo: TipoAdjunto): number => (tipo === "video" ? VIDEO_MAXIMO : MEDIA_MAXIMA);

/** Todo vive bajo este prefijo del bucket, separado del catálogo. */
const PREFIJO = "conversaciones/";
const MARCA = /\[ADJUNTO: ([a-f0-9]{32})\]/g;

export function marcaDeAdjunto(id: string): string {
  return `[ADJUNTO: ${id}]`;
}

/** Los ids de los adjuntos de un mensaje, en orden. */
export function idsDeAdjuntos(texto: string): string[] {
  return [...texto.matchAll(MARCA)].map((m) => m[1]);
}

/** El texto sin las marcas: lo que lee el modelo o lo que se copia. */
export function sinMarcasDeAdjunto(texto: string): string {
  return texto.replace(/\n?\[ADJUNTO: [a-f0-9]{32}\]/g, "").replace(/\n?\[ADJUNTO_FALLIDO: [^\]]*\]/g, "");
}

/**
 * El tipo de verdad. Telegram entrega todo como application/octet-stream y
 * WhatsApp manda las notas de voz como «audio/ogg; codecs=opus».
 */
function mimeDe(bytes: Uint8Array, mime: string, tipo: TipoAdjunto): string {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  // Solo los formatos de foto que no ejecutan nada: un SVG puede traer código.
  if (tipo === "imagen") return tipoDeImagen(bytes) ?? (FOTOS.has(base) ? base : "application/octet-stream");
  if (tipo === "audio") return base.startsWith("audio/") ? base : "audio/ogg";
  // Los videos de iPhone llegan como video/quicktime; lo desconocido se trata como mp4.
  if (tipo === "video") return /^video\/(mp4|webm|quicktime|3gpp)$/.test(base) ? base : "video/mp4";
  return base || "application/octet-stream";
}

/**
 * Lo que queda en el mensaje cuando un archivo NO se pudo guardar. Antes quedaba
 * un hueco mudo y el panel decía «llegó antes de que guardara las fotos», que es
 * mentira si falló hoy. `motivo`: «grande» (pasa del tope) o «descarga».
 */
export function marcaDeFallo(tipo: TipoAdjunto, motivo: "grande" | "descarga"): string {
  return `[ADJUNTO_FALLIDO: ${tipo} | ${motivo}]`;
}

/** Guarda el archivo y devuelve su id, o null si no se pudo. */
export async function guardarAdjunto(
  env: Env,
  conversationId: string,
  archivo: { bytes: Uint8Array; mime: string },
  tipo: TipoAdjunto,
  nombre: string | null = null,
  ahora = Date.now(),
): Promise<string | null> {
  const { bytes } = archivo;
  if (!env.CATALOG || bytes.byteLength === 0 || bytes.byteLength > maximoDe(tipo)) return null;
  try {
    const id = crypto.randomUUID().replace(/-/g, "");
    const key = `${PREFIJO}${id}`;
    const mime = mimeDe(bytes, archivo.mime, tipo);
    await env.CATALOG.put(key, bytes, { httpMetadata: { contentType: mime } });
    await env.DB.prepare(
      "INSERT INTO adjuntos (id, conversation_id, tipo, mime, nombre, r2_key, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, conversationId, tipo, mime, nombre?.slice(0, 200) ?? null, key, bytes.byteLength, ahora)
      .run();
    return id;
  } catch (e) {
    console.warn("[adjuntos] no se pudo guardar:", e);
    return null;
  }
}

/** Los adjuntos de una conversación, por id. */
export async function adjuntosDe(env: Env, conversationId: string): Promise<Map<string, Adjunto>> {
  const r = await env.DB.prepare("SELECT * FROM adjuntos WHERE conversation_id = ?")
    .bind(conversationId)
    .all<Adjunto>();
  return new Map((r.results ?? []).map((a) => [a.id, a]));
}

export async function adjuntoPorId(env: Env, id: string): Promise<Adjunto | null> {
  return (await env.DB.prepare("SELECT * FROM adjuntos WHERE id = ?").bind(id).first<Adjunto>()) ?? null;
}

/**
 * GET /admin/adjuntos/:id — el archivo, para el panel (detrás de la sesión).
 * Con rangos: Safari no reproduce un audio si el servidor no los acepta.
 */
export async function servirAdjunto(env: Env, id: string, req: Request, descargar: boolean): Promise<Response> {
  const a = /^[a-f0-9]{32}$/.test(id) ? await adjuntoPorId(env, id) : null;
  if (!a || !env.CATALOG) return new Response("No está.", { status: 404 });
  const rango = req.headers.get("range");
  const obj = await env.CATALOG.get(a.r2_key, rango ? { range: req.headers } : undefined);
  if (!obj) return new Response("No está.", { status: 404 });

  const seguro = SE_ABRE_EN_EL_PANEL.test(a.mime);
  const headers = new Headers({
    "content-type": seguro ? a.mime : "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  // El visor de PDF del navegador no abre con sandbox; el PDF no corre código en el panel.
  if (a.mime !== "application/pdf") headers.set("content-security-policy", "default-src 'none'; sandbox");
  const nombre = (a.nombre || `${a.tipo}-${a.id.slice(0, 8)}`).replace(/["\r\n]/g, "");
  headers.set(
    "content-disposition",
    `${descargar || !seguro ? "attachment" : "inline"}; filename="${nombre.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nombre)}`,
  );

  const r = (obj as R2ObjectBody & { range?: { offset?: number; length?: number; suffix?: number } }).range;
  if (rango && r) {
    const inicio = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const largo = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - inicio);
    headers.set("content-range", `bytes ${inicio}-${inicio + largo - 1}/${obj.size}`);
    headers.set("content-length", String(largo));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

/** Al borrar una conversación, sus archivos se van con ella. */
export async function borrarAdjuntosDe(env: Env, conversationId: string): Promise<void> {
  const r = await env.DB.prepare("SELECT r2_key FROM adjuntos WHERE conversation_id = ?")
    .bind(conversationId)
    .all<{ r2_key: string }>();
  const keys = (r.results ?? []).map((x) => x.r2_key);
  if (keys.length && env.CATALOG) await env.CATALOG.delete(keys);
  await env.DB.prepare("DELETE FROM adjuntos WHERE conversation_id = ?").bind(conversationId).run();
}
