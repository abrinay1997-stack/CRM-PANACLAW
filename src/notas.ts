// La nota interna del equipo: un mensaje que vive en la conversación pero que
// el cliente NO recibe. Hasta el 7-nov-2026 no existía: la nota que se deja al
// devolverle la conversación al bot se guardaba como un mensaje del equipo y en
// el panel se veía idéntica a una respuesta enviada, así que nadie podía saber
// si algo había salido o no.
//
// Se guarda como un mensaje `owner` con esta marca delante (sin migración). El
// panel la pinta aparte, y el bot la lee como contexto del equipo, no como algo
// que él haya dicho.

export const MARCA_NOTA = "[NOTA INTERNA] ";

export const esNotaInterna = (contenido: string): boolean => contenido.startsWith(MARCA_NOTA);

/** El texto de la nota, sin la marca. */
export const textoDeNota = (contenido: string): string =>
  esNotaInterna(contenido) ? contenido.slice(MARCA_NOTA.length) : contenido;

export const comoNota = (texto: string): string => `${MARCA_NOTA}${texto.trim()}`;

/** Cómo se la presentamos al modelo: contexto del equipo, no algo dicho al cliente. */
export const notaParaElModelo = (contenido: string): string =>
  `(Nota interna del equipo. El cliente no la ve y no debes mencionarla: ${textoDeNota(contenido)})`;
