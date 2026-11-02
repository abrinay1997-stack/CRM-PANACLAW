/**
 * Quién escribe sin venir a comprar (auditoría de Meta Ads, 1-nov-2026).
 *
 * En la primera semana de anuncios llegaron 22 conversaciones y ninguna venta.
 * Entre ellas: un señor que pedía $2,000 prestados, un diseñador que buscaba
 * empleo, gente que solo saludó y alguien que tocó el anuncio sin querer. El
 * bot anotó a dos de ellos como leads, y un lead le enseña a Meta a traer más
 * gente igual.
 *
 * Esto lo detecta sin la IA, leyendo lo que la persona escribió, y lo deja en
 * la conversación (`no_cliente` en conversations.metadata). Con esa marca:
 *   • captureLead no la anota (src/tools/captureLead.ts),
 *   • a Meta no se le avisa ningún lead (src/meta/conversiones.ts),
 *   • no recibe seguimiento (src/followup/run.ts),
 *   • el bot cierra con amabilidad en vez de venderle (src/agent.ts),
 *   • y el panel la enseña con su motivo, con un botón para quitarla.
 *
 * Conservador a propósito: una marca de más le quita a alguien la atención que
 * venía a buscar. Por eso cada regla pide la frase entera («quiero un
 * préstamo», «busco empleo») y no la palabra suelta: «¿puedo pagar en
 * quincenas?» y «quiero una página tipo portafolio» son clientes.
 *
 * El dueño manda: si quita la marca (o la pone a mano), el detector ya no toca
 * esa conversación (`no_cliente_revisado`).
 */
import { Db } from "./db/client";

export type MotivoNoCliente = "prestamo" | "empleo" | "por-error" | "sin-contenido" | "a-mano";

/** Cómo se lee cada motivo en el panel. */
export const MOTIVO_NO_CLIENTE: Record<MotivoNoCliente, string> = {
  prestamo: "Busca un préstamo",
  empleo: "Busca empleo",
  "por-error": "Escribió por error",
  "sin-contenido": "Solo saludó",
  "a-mano": "Marcado por usted",
};

/**
 * Los motivos que no se borran solos. «Solo saludó» sí: si después escribe
 * algo de verdad, deja de serlo.
 */
const PEGAJOSOS = new Set<MotivoNoCliente>(["prestamo", "empleo", "por-error", "a-mano"]);

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * El mensaje que el anuncio escribe solo cuando la persona lo toca. Los de
 * octubre de 2026: «Hola, vi el anuncio de la página web de $295 en 72 horas.
 * Quiero información.» Y los textos de siempre de Meta («¡Hola! Quiero más
 * información.»). Una pregunta frecuente tocada en el anuncio NO es esto: esa
 * ya dice qué quiere saber.
 */
const MENSAJE_DEL_ANUNCIO = [
  // Una sola oración entre «vi el anuncio» y «Quiero información»: si la
  // persona metió algo suyo en medio, ya escribió (el punto de «$1.200» no corta).
  /\bvi (el|su|tu|este|un) anuncio\b(?:[^.\n]|\.\d){0,160}[.!]?\s*quiero (mas )?informacion\b[.!]*/g,
  /^[¡!\s]*hola[!,.\s]*[¿]?(quiero|puedo (obtener|tener|recibir)|me (puede|pueden|puedes) dar|me gustaria (tener|recibir|saber)) (mas )?informacion( (sobre|de) (esto|este anuncio|el anuncio))?[.?!]*$/gm,
];

/**
 * Lo que no escribió la persona: marcas para el bot y rellenos del sistema.
 * Se aplican sobre el texto ya normalizado (minúsculas, sin tildes).
 */
const MARCAS = [
  /^\[(anuncio|adjunto|image_url): [^\n]*$/gm,
  /^\((imagen sin caption|audio sin transcripcion|no pude entender el audio|el cliente mando un audio|el cliente mando una imagen[^)]*)\)$/gm,
];

/** Lo que alguien dice para saludar, agradecer, bendecir o despedirse. */
const PALABRAS_DE_SALUDO = new Set(
  (
    "hola ola holi holis hello hi hey alo aló buenas buenos buena buen dia dias tardes noches tarde noche " +
    "saludos saludo saludar saludarle saludarte saludarles que tal como esta estas estan le les te lo la los " +
    "gracias muchas mil muchisimas bendiciones bendicion bendiga bendice guarde dios amen " +
    "igual igualmente muy feliz a todos todas ustedes usted ud de y con el un una hasta manana luego pronto bye chao adios " +
    "excelente saludito saluditos"
  ).split(/\s+/),
);

/**
 * Lo que la persona escribió de su puño: sin las marcas, sin los rellenos y
 * sin el mensaje automático del anuncio. Normalizado (sin tildes, minúsculas).
 */
export function loQueEscribio(contenido: string): string {
  let t = sinMarcas(contenido);
  for (const r of MENSAJE_DEL_ANUNCIO) t = t.replace(r, "");
  return t.trim();
}

function sinMarcas(contenido: string): string {
  let t = normalizar(contenido);
  for (const r of MARCAS) t = t.replace(r, "");
  return t.trim();
}

/**
 * ¿Es el mensaje con el que se abre un chat desde un anuncio? Trae la marca
 * del anuncio o el texto que el anuncio escribe solo.
 */
export function esAperturaDeAnuncio(contenido: string): boolean {
  return /^\[ANUNCIO: /m.test(contenido) || loQueEscribio(contenido) !== sinMarcas(contenido);
}

/**
 * ¿Solo saludó (o mandó una nota de voz sin nada)? Vacío cuenta como sí. Las
 * letras de otro alfabeto cuentan como texto: no son un saludo de la lista.
 */
export function soloSaluda(escrito: string): boolean {
  const palabras = escrito.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return palabras.every((p) => PALABRAS_DE_SALUDO.has(p));
}

/**
 * ¿Escribió algo propio, además del mensaje automático del anuncio y de un
 * saludo? Una foto también cuenta: alguien que manda su logo está hablando.
 */
export function escribioAlgoPropio(mensajesDelCliente: string[]): boolean {
  return mensajesDelCliente.some((m) => /\[IMAGE_URL: /.test(m) || !soloSaluda(loQueEscribio(m)));
}

const PRESTAMO =
  /\b(quiero|necesito|busco|ocupo|solicito|solicitar|pedir|pido|me urge) (un |una )?(prestamo|credito personal)|\bprestam[oe] de \$? ?\d|\bpresta(me|rme|rnos)\b|\b(dinero|plata) prestad[oa]|\bme (puede|pueden|podria|podrian) prestar|\bprestamista|\bcuanto (es|seria|cobran|me cobran) (de |el |los )?interes/;

const EMPLEO =
  /\b(busco|buscando|busca|en busca de|necesito|solicito) (de )?(empleo|trabajo|chamba)\b|\b(estan|estaran|siguen|andan) contratando|\b(hay|tienen|tendran) (alguna |algun )?(vacante|plaza|puesto)s?\b|\bvacantes?\b|\b(curriculum|curriculo|hoja de vida)\b|\b(mi|el|les envio mi|le envio mi|adjunto mi|aqui va mi|aqui esta mi) cv\b|\b(quiero|quisiera|me gustaria) trabajar (con|para) (ustedes|uds|usted|ud)\b|\b(les |le )?ofrezco mis servicios\b/;

const POR_ERROR =
  /\bsin querer\b|\b(toque|presione|pulse|marque|escribi|mande|abri|le di)\b[^\n]{0,25}\bpor (error|equivocacion)\b|\bno fui yo\b|\byo no (fui|escribi|mande|toque)\b|\b(numero|chat|mensaje) equivocad|\bme equivoque de (numero|chat)\b|\bborr(a|e|en)(me|nos)\b|\bme borr(a|e|en) de\b|\bsa(c|qu)(a|e|en)me de\b|\bme sa(c|qu)(a|e|en) de\b/;

/**
 * El motivo por el que esta persona no es cliente, o null. Lee todos sus
 * mensajes (del más viejo al más nuevo).
 *
 * «Solo saludó»: dos veces seguidas sin nada más que un saludo o una nota de
 * voz vacía, contando el primer mensaje solo si escribió algo además del
 * automático del anuncio (tocar el anuncio no es saludar).
 */
export function motivoNoCliente(mensajesDelCliente: string[]): MotivoNoCliente | null {
  const escritos = mensajesDelCliente.map(loQueEscribio);
  for (const e of escritos) {
    if (PRESTAMO.test(e)) return "prestamo";
    if (EMPLEO.test(e)) return "empleo";
    if (POR_ERROR.test(e)) return "por-error";
  }
  if (escribioAlgoPropio(mensajesDelCliente)) return null;
  // Sin nada propio: cuenta las veces que contestó. El primer mensaje, si es el
  // del anuncio, no es una respuesta (aunque lleve un «hola» delante).
  const respuestas = mensajesDelCliente.filter((m, i) => !(i === 0 && esAperturaDeAnuncio(m)));
  return respuestas.length >= 2 ? "sin-contenido" : null;
}

interface MarcaGuardada {
  motivo: MotivoNoCliente;
  at: number;
}

function leer(metadata: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(metadata ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** La marca que tiene la conversación, a partir de su metadata. */
export function marcaNoCliente(metadata: string | null | undefined): MotivoNoCliente | null {
  const m = leer(metadata).no_cliente as MarcaGuardada | undefined;
  return m?.motivo && m.motivo in MOTIVO_NO_CLIENTE ? m.motivo : null;
}

/** La marca de una conversación, leída de la base. */
export async function noClienteDe(db: Db, conversationId: string): Promise<MotivoNoCliente | null> {
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [conversationId]);
  return marcaNoCliente(fila?.metadata);
}

/**
 * Vuelve a mirar la conversación con lo último que escribió el cliente y
 * guarda la marca si cambió. Devuelve la marca vigente.
 */
export async function revisarNoCliente(db: Db, conversationId: string, ahora = Date.now()): Promise<MotivoNoCliente | null> {
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [conversationId]);
  const meta = leer(fila?.metadata);
  const guardada = marcaNoCliente(fila?.metadata);
  if (meta.no_cliente_revisado) return guardada;
  if (guardada && PEGAJOSOS.has(guardada)) return guardada;

  const mensajes = await db.all<{ content: string }>(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 60",
    [conversationId],
  );
  const motivo = motivoNoCliente(mensajes.map((m) => m.content));
  if (motivo === guardada) return guardada;
  if (motivo) meta.no_cliente = { motivo, at: ahora } satisfies MarcaGuardada;
  else delete meta.no_cliente;
  await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify(meta), conversationId]);
  return motivo;
}

/**
 * Lo que decide el dueño desde el panel: «no es cliente» (a mano) o «sí es
 * cliente» (quita la marca). Desde ahí el detector ya no toca la conversación.
 */
export async function decidirNoCliente(db: Db, conversationId: string, esCliente: boolean, ahora = Date.now()): Promise<void> {
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [conversationId]);
  if (!fila) return;
  const meta = leer(fila.metadata);
  if (esCliente) delete meta.no_cliente;
  else meta.no_cliente = { motivo: "a-mano", at: ahora } satisfies MarcaGuardada;
  meta.no_cliente_revisado = true;
  await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify(meta), conversationId]);
}

/**
 * Lo que se le dice al bot cuando la persona no viene a comprar. Va en un
 * bloque aparte, como <ahora>: el prompt grande no cambia.
 */
export function notaParaElBot(motivo: MotivoNoCliente): string {
  const que: Record<MotivoNoCliente, string> = {
    prestamo:
      "Esta persona busca un préstamo y el negocio no presta dinero. Díselo con amabilidad, en una o dos líneas, y despídete. No le ofrezcas ningún plan.",
    empleo:
      "Esta persona busca empleo o viene a ofrecer sus servicios, y el negocio no está contratando. Agradécele en una o dos líneas y despídete. No le prometas que la van a llamar ni que guardaste sus datos.",
    "por-error":
      "Esta persona escribió por error o pidió que no le escriban. Discúlpate en una línea y despídete. Si pidió que borren sus datos, pásalo a una persona con handoffHuman.",
    "sin-contenido":
      "Esta persona solo ha saludado. Contéstale en una línea, con palabras sencillas, preguntándole en qué le puedes ayudar. Nada de planes, precios ni enlaces todavía.",
    "a-mano":
      "El dueño marcó que esta persona no viene a comprar. Atiéndela con amabilidad y brevedad, sin ofrecerle planes.",
  };
  return (
    `<no_viene_a_comprar>\n${que[motivo]}\n` +
    "No la anotes con captureLead: no es un lead. Si en este mensaje pregunta de verdad por una página web, atiéndela normal.\n" +
    "</no_viene_a_comprar>"
  );
}
