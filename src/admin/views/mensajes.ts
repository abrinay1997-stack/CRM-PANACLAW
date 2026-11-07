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
import { esNotaInterna, textoDeNota } from "../../notas";
import { citaDe, reaccionDe, type EstadoDeMensaje } from "../../estadosDeEnvio";

export interface MensajeParaVer {
  /** El texto sin marcas. */
  texto: string;
  /** Los adjuntos guardados, en orden. */
  adjuntos: string[];
  /** El titular del anuncio del que vino, si vino de uno. */
  anuncio: string | null;
  /** Traía una foto que el panel no guardó (llegó antes del 28-oct-2026). */
  fotoSinGuardar: boolean;
  /** Archivos que ahora mismo no se pudieron guardar (descarga fallida o muy pesados). */
  fallos: { tipo: string; motivo: string }[];
  /** Lo reenvió el cliente: no lo escribió él. */
  reenviado: boolean;
  /** Respondió a un mensaje anterior: de quién era y qué decía. */
  cita: { de: string | null; extracto: string } | null;
  /** Reaccionó con un emoji a un mensaje. */
  reaccion: { emoji: string; extracto: string } | null;
  /** Los nombres de los documentos que traía. */
  documentos: string[];
  /**
   * Los avisos de relleno («(el cliente mandó un audio)», «(le mandamos:
   * cotizacion.pdf)»). Sobran cuando el archivo está a la vista; si no se pudo
   * guardar, son lo único que dice que hubo un archivo, y se enseñan.
   */
  rellenos: string[];
}

const RELLENO = /^\((imagen sin caption|el cliente mandó una imagen|el cliente mandó un audio|el cliente mandó un video|El cliente mandó un video\. .+|le mandamos: .+)\)$/i;

export function mensajeParaVer(contenido: string): MensajeParaVer {
  const adjuntos = [...contenido.matchAll(/\[ADJUNTO: ([a-f0-9]{32})\]/g)].map((m) => m[1]);
  const anuncioCrudo = contenido.match(/\[ANUNCIO: ([^\]]*)\]/)?.[1] ?? null;
  const anuncio = anuncioCrudo ? (anuncioCrudo.match(/«([^»]+)»/)?.[1] ?? "un anuncio de Meta") : null;
  const fallos = [...contenido.matchAll(/\[ADJUNTO_FALLIDO: (\w+) \| (\w+)\]/g)].map((m) => ({ tipo: m[1], motivo: m[2] }));
  const documentos = [...contenido.matchAll(/\[DOCUMENTO: \S+?(?: \| ([^\]]*))?\]/g)].map((m) => m[1]?.trim() || "documento");
  const reenviado = /^\[REENVIADO\]/.test(contenido);
  const lineas = contenido
    .replace(/^\[REENVIADO\] ?/, "")
    .replace(/\n?\[IMAGE_URL: [^\]]*\]/g, "")
    .replace(/\n?\[ADJUNTO: [a-f0-9]{32}\]/g, "")
    .replace(/\n?\[ADJUNTO_FALLIDO: [^\]]*\]/g, "")
    .replace(/\n?\[WAID: [^\]]*\]/g, "")
    .replace(/\n?\[CITA: [^\]]*\]/g, "")
    .replace(/\[REACCION: [^\]]*\]/g, "")
    .replace(/\n?\[ANUNCIO: [^\]]*\]/g, "")
    .replace(/\n?\[DOCUMENTO: [^\]]*\]/g, "")
    .split("\n");
  const esRelleno = (l: string) => RELLENO.test(l.trim());
  const texto = lineas.filter((l) => !esRelleno(l)).join("\n").trim();
  // «(imagen sin caption)» no dice nada: la foto ya se marca aparte.
  const rellenos = lineas.map((l) => l.trim()).filter((l) => esRelleno(l) && !/^\(imagen sin caption\)$/i.test(l));
  return { texto, adjuntos, anuncio, fotoSinGuardar: /\[IMAGE_URL: /.test(contenido), documentos, rellenos, fallos, reenviado, cita: citaDe(contenido), reaccion: reaccionDe(contenido) };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const ruta = (id: string) => `/admin/adjuntos/${id}`;

const NOMBRE_DE_TIPO: Record<string, string> = { imagen: "la foto", audio: "la nota de voz", video: "el video", documento: "el documento" };

/** Lo que se dice cuando un archivo no se pudo guardar: qué pasó y qué hacer. */
function avisoDeFallo(f: { tipo: string; motivo: string }): string {
  const que = NOMBRE_DE_TIPO[f.tipo] ?? "el archivo";
  const porque = f.motivo === "grande" ? "pesa más de lo que el panel guarda" : "no se pudo descargar";
  return `<span style="font-size:12px;color:var(--warn,var(--dim));display:inline-flex;align-items:center;gap:6px;max-width:100%">${ico("alert-triangle", 13)} No se pudo guardar ${que} (${porque}). Míralo en el teléfono o pídele que lo reenvíe.</span>`;
}

/** La foto, el reproductor o el documento. */
function bloqueDeAdjunto(a: Adjunto): string {
  if (a.tipo === "imagen") {
    return `<a href="${ruta(a.id)}" target="_blank" rel="noopener" data-visor aria-label="Abrir la foto en grande" style="display:block">
      <img src="${ruta(a.id)}" alt="Foto que mandó el cliente" loading="lazy"
           style="display:block;width:240px;max-width:100%;max-height:320px;object-fit:cover;border-radius:10px;border:1px solid var(--line);background:var(--raise)">
    </a>`;
  }
  if (a.tipo === "video") {
    return `<div style="display:flex;flex-direction:column;gap:6px">
      <span style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px">${ico("video")} Video</span>
      <video controls playsinline preload="metadata" src="${ruta(a.id)}"
             style="display:block;width:280px;max-width:100%;max-height:360px;border-radius:10px;border:1px solid var(--line);background:#000"></video>
      <a href="${ruta(a.id)}?descargar=1" style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:5px">${ico("download", 12)} Descargar el video</a>
    </div>`;
  }
  if (a.tipo === "audio") {
    // WhatsApp manda OGG/Opus y Safari (iPhone) suele no reproducirlo: si falla,
    // el aviso lo dice en vez de dejar un reproductor mudo.
    return `<div style="display:flex;flex-direction:column;gap:6px">
      <span style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px">${ico("mic")} Nota de voz</span>
      <audio controls preload="metadata" src="${ruta(a.id)}" style="width:260px;max-width:100%"
             onerror="this.nextElementSibling.nextElementSibling.hidden=false"></audio>
      <a href="${ruta(a.id)}?descargar=1" style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:5px">${ico("download", 12)} Descargar el audio</a>
      <span hidden style="font-size:12px;color:var(--dim)">Este navegador no reproduce el formato de WhatsApp. Descárgalo o ábrelo desde el computador.</span>
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
  if (m.reaccion) {
    return `<span style="display:inline-flex;align-items:center;gap:8px;font-size:14px"><span style="font-size:24px;line-height:1">${esc(m.reaccion.emoji)}</span> <span style="color:var(--muted)">Reaccionó${m.reaccion.extracto ? ` a «${esc(m.reaccion.extracto)}»` : " a un mensaje"}</span></span>`;
  }
  if (m.cita) {
    const quien = m.cita.de === "cliente" ? "Cliente" : m.cita.de === "equipo" ? "Tú" : m.cita.de === "bot" ? "Bot" : "Mensaje anterior";
    bloques.unshift(
      `<div style="border-left:3px solid var(--accent);padding:4px 8px;font-size:12px;color:var(--muted);background:rgba(255,255,255,.05);border-radius:6px;max-width:100%">${ico("corner-up-left", 12)} <b>${quien}</b>${m.cita.extracto ? `: «${esc(m.cita.extracto)}»` : ""}</div>`,
    );
  }
  if (m.reenviado) {
    bloques.unshift(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px;font-style:italic">${ico("forward", 12)} Reenviado</span>`);
  }
  // Lo que no se pudo guardar se dice, no se calla.
  for (const f of m.fallos) bloques.push(avisoDeFallo(f));

  // El archivo no se pudo guardar: el aviso de relleno es lo único que queda.
  if (guardados.length === 0 && m.fallos.length === 0) {
    for (const r of m.rellenos) {
      bloques.push(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px">${ico("file-text")} ${esc(r.slice(1, -1))}</span>`);
    }
  }
  if (m.fotoSinGuardar && !hayFoto && m.fallos.length === 0) {
    bloques.push(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px">${ico("image")} Mandó una foto (llegó antes de que el panel guardara las fotos)</span>`);
  }
  if (!hayDocumento) {
    for (const nombre of m.documentos) {
      bloques.push(`<span style="font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:6px">${ico("file-text")} ${esc(nombre)}</span>`);
    }
  }
  const texto = m.texto
    ? `${hayAudio ? `<div style="font-size:12px;color:var(--dim);margin-bottom:2px">Transcripción</div>` : ""}<div style="white-space:pre-wrap;overflow-wrap:anywhere">${conFormatoDeWhatsApp(esc(m.texto))}</div>`
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
const NOTA = "Nota interna (el cliente no la ve)";

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
    const m = mensajeParaVer(textoDeNota(msg.content));
    const extras = m.adjuntos
      .map((id) => adjuntos.get(id))
      .filter((a): a is Adjunto => !!a)
      .map((a) => (a.tipo === "imagen" ? "(foto)" : a.tipo === "audio" ? "(nota de voz)" : a.tipo === "video" ? "(video)" : `(documento: ${a.nombre || "sin nombre"})`));
    if (extras.length === 0) extras.push(...m.rellenos);
    if (m.fotoSinGuardar && !extras.includes("(foto)")) extras.push("(foto)");
    if (m.anuncio) extras.push(`(llegó desde el anuncio «${m.anuncio}»)`);
    if (m.reenviado) extras.push("(reenviado)");
    if (m.cita) extras.push(`(responde a: «${m.cita.extracto}»)`);
    if (m.reaccion) extras.push(`(reaccionó con ${m.reaccion.emoji}${m.reaccion.extracto ? ` a: «${m.reaccion.extracto}»` : ""})`);
    const cuerpo = [extras.join(" "), m.texto].filter(Boolean).join(" ");
    const quien = msg.role === "owner" && esNotaInterna(msg.content) ? NOTA : (QUIEN[msg.role] ?? msg.role);
    return `[${horaDelNegocio(env, msg.created_at, true)}] ${quien}: ${cuerpo}`;
  });
  return `${cabecera.join("\n")}\n\n${lineas.join("\n\n")}\n`;
}

/** «hoy», «ayer» o «7 nov»: la cabecera de cada día en el hilo. */
export function etiquetaDeDia(env: Env, ms: number, ahora = Date.now()): string {
  const clave = (t: number) =>
    new Date(t).toLocaleDateString("en-CA", { timeZone: env.BOT_TIMEZONE || undefined });
  const dia = clave(ms);
  if (dia === clave(ahora)) return "Hoy";
  if (dia === clave(ahora - 86_400_000)) return "Ayer";
  return new Date(ms).toLocaleDateString("es-MX", {
    timeZone: env.BOT_TIMEZONE || undefined,
    day: "numeric",
    month: "short",
    ...(clave(ms).slice(0, 4) !== clave(ahora).slice(0, 4) ? { year: "numeric" } : {}),
  });
}

/** Si dos instantes caen en el mismo día del negocio. */
export function mismoDia(env: Env, a: number, b: number): boolean {
  const clave = (t: number) =>
    new Date(t).toLocaleDateString("en-CA", { timeZone: env.BOT_TIMEZONE || undefined });
  return clave(a) === clave(b);
}

/** El «✓ Enviado», «✓✓ Entregado», «✓✓ Leído» o «✗ No llegó» del pie de un mensaje nuestro. */
export function marcaDeEntrega(e: EstadoDeMensaje | null): string {
  if (!e) return "";
  if (e.estado === "fallido") {
    return `<span style="color:var(--bad);font-weight:600" title="${esc(e.detalle ?? "")}">${ico("x-circle", 12)} No llegó${e.detalle ? `: ${esc(e.detalle)}` : ""}</span>`;
  }
  if (e.estado === "leido") return `<span style="color:var(--info)" title="El cliente lo leyó">${ico("check-check", 13)} Leído</span>`;
  if (e.estado === "entregado") return `<span>${ico("check-check", 13)} Entregado</span>`;
  return `<span>${ico("check", 13)} Enviado</span>`;
}

/**
 * Lo que el cliente ve en WhatsApp: *negrita*, _cursiva_, ~tachado~ y los enlaces
 * clicables. El texto llega ya escapado; aquí solo se agregan etiquetas seguras.
 * Antes el panel enseñaba los asteriscos tal cual («*PanaClaw Start*»).
 */
export function conFormatoDeWhatsApp(escapado: string): string {
  return escapado
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--info);text-decoration:underline">$1</a>')
    // Como WhatsApp: el marcador de apertura no lleva un espacio pegado ni el de cierre
    // tampoco, así «2 * 3 * 4» se queda como está.
    .replace(/(^|[\s(¡¿])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=$|[\s).,;:!?])/g, "$1<b>$2</b>")
    .replace(/(^|[\s(¡¿])_([^\s_](?:[^_\n]*?[^\s_])?)_(?=$|[\s).,;:!?])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(¡¿])~([^\s~](?:[^~\n]*?[^\s~])?)~(?=$|[\s).,;:!?])/g, "$1<s>$2</s>");
}
