// Lo que se ve de cada mensaje en el panel, y lo que se copia o se descarga.
//
// El texto guardado lleva marcas que son para el bot, no para el dueño:
// [IMAGE_URL: …] (un enlace que vence a los 10 minutos), [ADJUNTO: <id>] (el
// archivo guardado, src/media/adjuntos.ts), [ANUNCIO: …] (de qué anuncio vino)
// y [DOCUMENTO: <url> | <nombre>]. Hasta el 28-oct-2026 el panel las mostraba
// tal cual, con la firma del enlace y todo. Aquí se convierten en la foto, el
// reproductor de la nota de voz, el documento y una línea con el anuncio.
import type { Env } from "../../env";
import type { Adjunto } from "../../media/adjuntos";
import { channelLabel, telefonoDelCliente } from "../../channels/labels";
import { ico } from "./layout";

export interface MensajeParaVer {
  /** El texto sin marcas. */
  texto: string;
  /** Los adjuntos guardados, en orden. */
  adjuntos: string[];
  /** El titular del anuncio del que vino, si vino de uno. */
  anuncio: string | null;
  /** Traía una foto que el panel no guardó (llegó antes del 28-oct-2026). */
  fotoSinGuardar: boolean;
  /** Los nombres de los documentos que traía. */
  documentos: string[];
}

const RELLENO = /^\((imagen sin caption|el cliente mandó una imagen|el cliente mandó un audio)\)$/i;

export function mensajeParaVer(contenido: string): MensajeParaVer {
  const adjuntos = [...contenido.matchAll(/\[ADJUNTO: ([a-f0-9]{32})\]/g)].map((m) => m[1]);
  const anuncioCrudo = contenido.match(/\[ANUNCIO: ([^\]]*)\]/)?.[1] ?? null;
  const anuncio = anuncioCrudo ? (anuncioCrudo.match(/«([^»]+)»/)?.[1] ?? "un anuncio de Meta") : null;
  const documentos = [...contenido.matchAll(/\[DOCUMENTO: \S+?(?: \| ([^\]]*))?\]/g)].map((m) => m[1]?.trim() || "documento");
  const texto = contenido
    .replace(/\n?\[IMAGE_URL: [^\]]*\]/g, "")
    .replace(/\n?\[ADJUNTO: [a-f0-9]{32}\]/g, "")
    .replace(/\n?\[ANUNCIO: [^\]]*\]/g, "")
    .replace(/\n?\[DOCUMENTO: [^\]]*\]/g, "")
    .split("\n")
    .filter((l) => !RELLENO.test(l.trim()))
    .join("\n")
    .trim();
  return { texto, adjuntos, anuncio, fotoSinGuardar: /\[IMAGE_URL: /.test(contenido), documentos };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const ruta = (id: string) => `/admin/adjuntos/${id}`;

/** La foto, el reproductor o el documento. */
function bloqueDeAdjunto(a: Adjunto): string {
  if (a.tipo === "imagen") {
    return `<a href="${ruta(a.id)}" target="_blank" rel="noopener" aria-label="Abrir la foto en grande" style="display:block">
      <img src="${ruta(a.id)}" alt="Foto que mandó el cliente" loading="lazy"
           style="display:block;width:240px;max-width:100%;max-height:320px;object-fit:cover;border-radius:10px;border:1px solid var(--line);background:var(--raise)">
    </a>`;
  }
  if (a.tipo === "audio") {
    return `<div style="display:flex;flex-direction:column;gap:6px">
      <span style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px">${ico("mic")} Nota de voz</span>
      <audio controls preload="metadata" src="${ruta(a.id)}" style="width:260px;max-width:100%;color-scheme:dark"></audio>
      <a href="${ruta(a.id)}?descargar=1" style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:5px">${ico("download", 12)} Descargar el audio</a>
    </div>`;
  }
  return `<a href="${ruta(a.id)}" target="_blank" rel="noopener" class="chip tap"
     style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px;background:var(--panel);border:1px solid var(--linelit);color:var(--cream);font-size:12.5px;max-width:100%">
    ${ico("file-text", 15)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.nombre || "Documento")}</span>
  </a>`;
}

/**
 * El cuerpo de la burbuja: los adjuntos arriba y el texto debajo. Con una nota
 * de voz, el texto es lo que transcribió el bot, y se dice.
 */
export function cuerpoDelMensaje(contenido: string, adjuntos: Map<string, Adjunto>): string {
  const m = mensajeParaVer(contenido);
  const guardados = m.adjuntos.map((id) => adjuntos.get(id)).filter((a): a is Adjunto => !!a);
  const bloques = guardados.map(bloqueDeAdjunto);
  const hayFoto = guardados.some((a) => a.tipo === "imagen");
  const hayAudio = guardados.some((a) => a.tipo === "audio");
  const hayDocumento = guardados.some((a) => a.tipo === "documento");

  if (m.fotoSinGuardar && !hayFoto) {
    bloques.push(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px">${ico("image")} Mandó una foto (llegó antes de que el panel guardara las fotos)</span>`);
  }
  if (!hayDocumento) {
    for (const nombre of m.documentos) {
      bloques.push(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px">${ico("file-text")} ${esc(nombre)}</span>`);
    }
  }
  const texto = m.texto
    ? `${hayAudio ? `<div style="font-size:12px;color:var(--dim);margin-bottom:2px">Transcripción</div>` : ""}<div style="white-space:pre-wrap">${esc(m.texto)}</div>`
    : "";
  return [...bloques, texto].filter(Boolean).join(`<div style="height:8px"></div>`);
}

/** La línea de debajo de la burbuja cuando el cliente llegó desde un anuncio. */
export function lineaDeAnuncio(contenido: string): string {
  const { anuncio } = mensajeParaVer(contenido);
  if (!anuncio) return "";
  return `<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px;max-width:100%">${ico("megaphone", 12)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Llegó desde el anuncio «${esc(anuncio)}»</span></span>`;
}

/** +507 6946-3706 en vez de +50769463706. */
export function telefonoLegible(tel: string): string {
  const d = tel.replace(/\D/g, "");
  if (d.startsWith("507") && d.length === 11) return `+507 ${d.slice(3, 7)}-${d.slice(7)}`;
  return tel;
}

/** La hora del negocio, no la del servidor. */
export function horaDelNegocio(env: Env, ms: number, conAnio = false): string {
  return new Date(ms).toLocaleString("es-MX", {
    timeZone: env.BOT_TIMEZONE || undefined,
    day: "2-digit",
    month: "short",
    ...(conAnio ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

const QUIEN: Record<string, string> = { user: "Cliente", assistant: "Bot", owner: "Equipo", tool: "Sistema" };

/**
 * La conversación en texto plano, para copiarla o descargarla. Las fotos y los
 * audios quedan dichos, no pegados.
 */
export function conversacionEnTexto(
  env: Env,
  conv: { display_name: string | null; channel: string; channel_user_id: string },
  msgs: { role: string; content: string; created_at: number }[],
  adjuntos: Map<string, Adjunto>,
): string {
  const tel = telefonoDelCliente(conv.channel, conv.channel_user_id);
  const cabecera = [
    `Conversación con ${conv.display_name || conv.channel_user_id}`,
    `Canal: ${channelLabel(conv.channel)}${tel ? ` · ${telefonoLegible(tel)}` : ""}`,
    `${env.BUSINESS_NAME || "Bot"} · exportada el ${horaDelNegocio(env, Date.now(), true)}`,
  ];
  const lineas = msgs.map((msg) => {
    const m = mensajeParaVer(msg.content);
    const extras = m.adjuntos
      .map((id) => adjuntos.get(id))
      .filter((a): a is Adjunto => !!a)
      .map((a) => (a.tipo === "imagen" ? "(foto)" : a.tipo === "audio" ? "(nota de voz)" : `(documento: ${a.nombre || "sin nombre"})`));
    if (m.fotoSinGuardar && !extras.includes("(foto)")) extras.push("(foto)");
    if (m.anuncio) extras.push(`(llegó desde el anuncio «${m.anuncio}»)`);
    const cuerpo = [extras.join(" "), m.texto].filter(Boolean).join(" ");
    return `[${horaDelNegocio(env, msg.created_at, true)}] ${QUIEN[msg.role] ?? msg.role}: ${cuerpo}`;
  });
  return `${cabecera.join("\n")}\n\n${lineas.join("\n\n")}\n`;
}
