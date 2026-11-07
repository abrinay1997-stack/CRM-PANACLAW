/**
 * La respuesta, en el formato que WhatsApp sí entiende.
 *
 * Los modelos escriben Markdown: `**negrita**`, `## Títulos`, `[texto](url)`.
 * WhatsApp no: la negrita es con UN asterisco (`*negrita*`) y lo demás sale tal
 * cual, con los símbolos a la vista. El 25-oct-2026, con Muse Spark, la lista de
 * planes le llegó al cliente como «**1. Sitios web**».
 */

/** Los canales que muestran el texto con las reglas de WhatsApp. */
export function esWhatsApp(canal: string): boolean {
  return canal === "whatsapp" || canal === "whatsapp-qr" || canal === "twilio";
}

export function formatoWhatsApp(texto: string): string {
  return (
    texto
      // **negrita** / __negrita__ → *negrita*
      .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "*$1*")
      .replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, "*$1*")
      // ## Título → *Título*
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*")
      // [texto](https://…) → texto: https://… (el enlace queda a la vista y se puede tocar)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, url: string) =>
        t.trim() === url ? url : `${t}: ${url}`,
      )
  );
}

/** Más largo que esto, el texto de antes de una tool ya es una respuesta. */
const NARRACION_MAX = 240;

/**
 * El texto de la respuesta sin la narración de antes de las tools. null si no
 * hay nada que quitar (y entonces se queda el texto tal cual salió).
 */
export function sinNarracion(steps: { text?: string; toolCalls?: unknown[] }[]): string | null {
  const textos = steps.map((s) => (s.text ?? "").trim());
  // Con un solo paso que habló no hay nada que separar: sale tal cual.
  if (textos.filter(Boolean).length <= 1) return null;
  const ultimoConTexto = textos.reduce((u, t, i) => (t ? i : u), -1);
  const quedan = textos.filter(
    (t, i) =>
      t && !(i < ultimoConTexto && (steps[i].toolCalls?.length ?? 0) > 0 && t.length <= NARRACION_MAX),
  );
  // Entre pasos, un párrafo: antes se pegaban («…los detalles.¡Hola!»).
  return quedan.join("\n\n").trim() || null;
}

const EMOJI = /\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic}|\ufe0f|[\u{1f3fb}-\u{1f3ff}])*/gu;

export function tieneEmoji(texto: string): boolean {
  return new RegExp(EMOJI.source, "u").test(texto);
}

/**
 * Como mucho un emoji por mensaje, y no en dos mensajes seguidos. Está en el
 * prompt («como mucho uno por mensaje, y no en todos»), pero el 31-oct-2026
 * Muse Spark cerró cinco respuestas seguidas con 🙌. Se deja el primero.
 */
/**
 * Sin ningún emoji: el trato de usted es la atención de una empresa (2-nov-2026,
 * el dueño pidió un bot más profesional). El prompt ya lo dice; esto lo asegura.
 */
export function quitarEmojis(texto: string): string {
  return dosificarEmojis(texto, true);
}

export function dosificarEmojis(texto: string, elAnteriorLlevaba: boolean): string {
  let vistos = 0;
  const limpio = texto.replace(EMOJI, (e) => (!elAnteriorLlevaba && vistos++ === 0 ? e : ""));
  if (limpio === texto) return texto;
  // Donde estaba el emoji no queda un espacio de más ni uno antes de la puntuación.
  return limpio
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * El saludo según la hora del negocio. De 5:00 a 11:59, «Buenos días»; hasta
 * las 18:59, «Buenas tardes»; el resto, «Buenas noches».
 */
export function saludoSegunHora(minutoDelDia: number): string {
  if (minutoDelDia >= 5 * 60 && minutoDelDia < 12 * 60) return "Buenos días";
  if (minutoDelDia >= 12 * 60 && minutoDelDia < 19 * 60) return "Buenas tardes";
  return "Buenas noches";
}

/** ¿La respuesta ya empieza saludando o agradeciendo que escribió? */
const YA_SALUDA = /^[\s¡*_]*(hola|buen[oa]s?\b|buen d[ií]a|saludos|bienvenid|(muchas )?gracias\b)/i;

/**
 * La primera respuesta de una conversación nunca sale sin saludo (7-nov-2026).
 * Al acortar el primer mensaje a quien llega de un anuncio («2 líneas y una
 * pregunta»), el bot empezó a contestar «Sí, es nuestro plan Start…» sin un
 * buenos días ni un gracias, y el dueño lo vio seco, poco cordial, en todas
 * las conversaciones. Si el modelo no saludó, se le antepone el saludo de la
 * hora y las gracias; si ya saludó, se deja como está.
 */
export function conSaludoInicial(texto: string, minutoDelDia: number, negocio?: string): string {
  if (!texto.trim() || YA_SALUDA.test(texto)) return texto;
  const a = negocio?.trim() ? ` a ${negocio.trim()}` : "";
  return `${saludoSegunHora(minutoDelDia)}, gracias por escribirnos${a}.\n${texto}`;
}
