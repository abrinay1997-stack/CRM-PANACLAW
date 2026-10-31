// El revisor: lo que la respuesta NO puede decir, comprobado ANTES de enviarla.
//
// Viene de Baby Caleb (mismo motor; la idea fue del dueño de PanaClaw). Allá,
// del 29-sep al 6-oct-2026 y con todas las reglas escritas en el prompt, el bot
// le dijo a una clienta "le confirmo que recibimos su abono total de $57.50"
// porque ella escribió que ya había pagado, "actualizó" un pedido que ya había
// salido y dejó "(precio del producto)" en una respuesta. Ninguna regla
// faltaba: faltaba alguien que mirara la respuesta antes de mandarla.
//
// Esto es ese alguien, y es deliberadamente tonto: expresiones regulares, sin
// IA. Así no cuesta nada, no tarda nada y no se equivoca de la misma manera que
// el modelo al que revisa. Solo busca lo que se puede comprobar sin entender la
// conversación; lo demás sigue siendo del prompt.
//
// Adaptado a PanaClaw (25-oct-2026): aquí se tutea y se venden servicios, no
// productos con envío. Lo que no aplica se quedó fuera: el tuteo (aquí es lo
// correcto), los montos (los vigila src/replies/cifras.ts) y "no mandes a otro
// número" (aquí el WhatsApp se da cuando el cliente pide una persona).
//
// Lo que encuentra no se tira: se le devuelve al modelo UNA vez para que la
// rehaga (src/agent.ts). Si un problema "bloquea" sigue ahí después, la
// respuesta no sale y la conversación pasa a una persona.

export type Gravedad = "corrige" | "bloquea";

export interface Problema {
  codigo: string;
  gravedad: Gravedad;
  /** El trozo de la respuesta que lo disparó, para el modelo y para los logs. */
  frase: string;
  /** Qué está mal y cómo se arregla, en palabras que el modelo pueda seguir. */
  explicacion: string;
}

export interface FraseProhibida {
  frase: string;
  motivo: string;
}

export interface ContextoRevision {
  /** Frases que el negocio no permite nunca (panel → Configuración). */
  frasesProhibidas?: FraseProhibida[];
  /**
   * Lo que escribió el cliente en este turno. Una frase prohibida que ÉL dijo
   * no se le está revelando: repetir sus palabras no es romper la regla.
   */
  textoDelCliente?: string;
  /**
   * Las últimas respuestas del bot en esta conversación, la más reciente
   * primero. Con ellas se ve si está repitiendo la misma pregunta.
   */
  respuestasAnteriores?: string[];
}

/** Sin tildes ni mayúsculas, con los espacios colapsados. */
export const normalizar = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

interface Regla {
  codigo: string;
  gravedad: Gravedad;
  patrones: RegExp[];
  explicacion: string;
  /**
   * Sobre el texto en minúsculas CON tildes. Hace falta cuando la tilde es lo
   * único que separa lo prohibido de lo correcto: "reservé" (ya lo hice) contra
   * "reserve" (que tú reserves).
   */
  conTildes?: boolean;
  /**
   * Si la oración es una condición o una regla general ("cuando recibimos tu
   * pago, arrancamos"), no es una promesa ni una confirmación: es lo que dice la
   * base de conocimiento.
   */
  admiteCondicional?: boolean;
}

/**
 * ¿La oración es una condición? Se mira con tildes: el «sí» afirmativo no es
 * el «si» de una condición, y sin tildes son la misma palabra. «Sí, ya
 * recibimos tu pago» se escapaba del revisor en Baby Caleb por eso.
 */
function esCondicion(oracionConTildes: string): boolean {
  return CONDICIONAL.test(normalizar(oracionConTildes.replace(/(^|[^\p{L}])sí(?![\p{L}])/gu, "$1")));
}

/** Palabras que convierten una oración en condición o regla general. */
const CONDICIONAL =
  /\b(si|cuando|una vez|en cuanto|apenas|despues de que|hasta que|antes de que|al recibir|con (el |tu |su )?(pago|adelanto|anticipo|50 ?%))\b/;

/**
 * El principio de la oración que contiene la posición `i`. Un punto no corta si
 * es de "a.m."/"p.m." ni si va entre cifras ("$1,200.00").
 */
function oracionEn(texto: string, i: number): string {
  for (let j = i - 1; j >= 0; j--) {
    const c = texto[j];
    if (c === "\n" || c === "!" || c === "?") return texto.slice(j + 1, i);
    if (c !== ".") continue;
    const alrededor = texto.slice(Math.max(0, j - 3), j + 3);
    if (/[ap]\.m/.test(alrededor) || /\d\.\d/.test(texto.slice(j - 1, j + 2))) continue;
    return texto.slice(j + 1, i);
  }
  return texto.slice(0, i);
}

const DIA = "(hoy|manana|pasado manana|esta tarde|esta noche|esta semana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo))";

// Los patrones van sobre el texto NORMALIZADO (sin tildes, en minúsculas),
// salvo los de las reglas con `conTildes`.
const REGLAS: Regla[] = [
  {
    codigo: "pago-confirmado",
    gravedad: "bloquea",
    patrones: [
      /\b(recibimos|recibi|hemos recibido|ya recibimos|ya tenemos|ya nos llego|nos llego)\s+(tu|su|el)\s+(pago|abono|adelanto|anticipo|comprobante|transferencia|deposito|yappy)/,
      /\b(pago|abono|adelanto|anticipo|comprobante|transferencia|deposito)\s+(ya\s+)?(esta|fue|ha sido|quedo|queda)\s+(confirmad|recibid|verificad|validad|aprobad)/,
      /\b(pago|abono|adelanto|anticipo|deposito)\s+(confirmado|recibido|verificado|aprobado)\b/,
      /\b(te|le) confirmo (que )?(ya )?(recibimos|tu pago|su pago|el pago|tu adelanto|el adelanto|tu comprobante)/,
    ],
    admiteCondicional: true,
    explicacion:
      "Diste por recibido o confirmado un pago. No ves cuentas ni comprobantes: aunque el cliente diga " +
      "que ya pagó o mande la captura, dile que una persona del equipo lo verifica y le confirma, y llama " +
      "handoffHuman.",
  },
  {
    codigo: "proyecto-tocado",
    gravedad: "corrige",
    conTildes: true,
    admiteCondicional: true,
    patrones: [
      /(?<![\p{L}])(reservé|aparté|separé|te reservo|te aparto|te separo|ya te reservé)\s+(tu|el|un|su)\s+(cupo|lugar|espacio|turno)(?![\p{L}])/u,
      /(?<![\p{L}])(tu|el|su) (proyecto|pedido|cupo|plan|sitio|página) (ya )?(queda|quedó|está) (confirmado|confirmada|reservado|reservada|agendado|agendada|apartado|apartada|activado|activada|contratado|contratada)(?![\p{L}])/u,
      /(?<![\p{L}])ya (arrancamos|empezamos|comenzamos) (con )?(tu|el|su) (proyecto|sitio|página|pedido)(?![\p{L}])/u,
    ],
    explicacion:
      "Dijiste que reservaste un cupo, que arrancaste o que confirmaste el proyecto. No puedes: eso lo " +
      "hace una persona del equipo cuando valida el adelanto. Dilo así (\"una persona del equipo te " +
      "reserva el cupo\"), y si el cliente ya pagó o quiere arrancar, llama handoffHuman.",
  },
  {
    codigo: "promesa-de-fecha",
    gravedad: "corrige",
    admiteCondicional: true,
    patrones: [
      new RegExp(
        `\\b(lo tienes|la tienes|lo tendras|la tendras|te lo entregamos|te la entregamos|queda listo|queda lista|estara listo|estara lista|esta listo|esta lista|sale|sale al aire|se publica)\\s+(listo |lista )?${DIA}\\b`,
      ),
      /\b(te escriben|te contactan|te llaman|te responden|te confirman|te contesta|te escribe|te llama)\s+(en (los proximos|unos|5|cinco|10|diez) minutos|ahorita|ya mismo|enseguida)\b/,
    ],
    explicacion:
      "Prometiste un día u hora concretos para ESE cliente. No tienes la agenda del equipo. Da el plazo " +
      "publicado como regla (\"el Start se entrega en 72 horas desde que tenemos tu material y el 50 %\"), " +
      "no como promesa, o di que una persona le confirma la fecha.",
  },
  {
    codigo: "hueco-de-plantilla",
    gravedad: "corrige",
    patrones: [
      /\((precio|monto|total|costo|fecha|enlace|link)( del [a-z ]{3,25})?\)/,
      /\[(nombre|precio|monto|fecha|enlace|link|plan|producto|cliente)[^\]]{0,25}\]/,
      /\[completa aqui/,
      /\{\{|\}\}/,
    ],
    explicacion:
      "Dejaste un hueco de plantilla en lugar del dato. Búscalo con searchKb, o no lo menciones.",
  },
  {
    codigo: "datos-bancarios",
    gravedad: "corrige",
    patrones: [/\b(el )?(nombre|titular|numero) de la cuenta (es|seria)\b/, /\bla cuenta (es|esta) a nombre de\b/],
    explicacion:
      "Diste (o inventaste) datos de una cuenta bancaria. No los tienes: si los piden, una persona del " +
      "equipo los da; llama handoffHuman.",
  },
];

/** Un fragmento alrededor de una coincidencia, para mostrarle al modelo qué dijo. */
function fragmento(texto: string, normal: string, indice: number, largo: number): string {
  const desde = Math.max(0, indice - 30);
  return normal.slice(desde, indice + largo + 30).trim() || texto.slice(0, 80);
}

/** Revisa una respuesta. Pura: no llama a nada ni escribe nada. */
export function revisarRespuesta(texto: string, ctx: ContextoRevision = {}): Problema[] {
  const problemas: Problema[] = [];
  if (!texto.trim()) return problemas;
  const normal = normalizar(texto);
  const minusculas = texto.toLowerCase().replace(/\s+/g, " ");

  for (const r of REGLAS) {
    const donde = r.conTildes ? minusculas : normal;
    let hallado = false;
    for (const p of r.patrones) {
      const global = new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
      for (const m of donde.matchAll(global)) {
        if (m.index === undefined) continue;
        // Con tildes: el texto normalizado y el de minúsculas miden lo mismo
        // (los modelos escriben las tildes compuestas), así que el índice vale.
        if (r.admiteCondicional && esCondicion(oracionEn(minusculas, m.index))) continue;
        problemas.push({
          codigo: r.codigo,
          gravedad: r.gravedad,
          frase: fragmento(texto, donde, m.index, m[0].length),
          explicacion: r.explicacion,
        });
        hallado = true;
        break;
      }
      if (hallado) break; // una vez por regla basta
    }
  }

  const repetida = preguntaRepetida(texto, ctx.respuestasAnteriores ?? []);
  if (repetida) problemas.push(repetida);

  const dichoPorEl = normalizar(ctx.textoDelCliente ?? "");
  for (const f of ctx.frasesProhibidas ?? []) {
    const aguja = normalizar(f.frase).trim();
    const i = aguja ? normal.indexOf(aguja) : -1;
    if (i >= 0 && !dichoPorEl.includes(aguja)) {
      problemas.push({
        codigo: "frase-prohibida",
        gravedad: "bloquea",
        frase: fragmento(texto, normal, i, aguja.length),
        explicacion: `Escribiste "${f.frase}", que este negocio no permite${f.motivo ? `: ${f.motivo}` : ""}. Quítalo.`,
      });
    }
  }

  return problemas;
}

/**
 * Palabras de relleno que salen en cualquier pregunta («cuéntame», «quieres»).
 * Se mira por las palabras de 6 letras o más que quedan: el tema.
 */
const RELLENO_DE_PREGUNTA = new Set([
  "cuentame", "cuenteme", "cuenta", "cuente", "cuentas", "comenta", "comente", "digame", "quieres", "quiere", "quisieras", "gustaria", "puedes", "podrias",
  "necesitas", "necesita", "necesitaria", "ayudarte", "ayudarle", "prefieres", "prefiere", "confirma",
  "confirmas", "confirmarte", "confirmarle", "confirme", "seguimos", "avanzamos", "arrancamos", "parece",
  "contarme", "decirme", "ustedes",
]);

/** Las preguntas de un texto: de «¿» (o el inicio de la oración) a «?». */
function preguntasDe(texto: string): string[] {
  return (texto.match(/[^.!?\n¡]*\?/g) ?? []).map((p) => p.replace(/^[^¿]*¿/, ""));
}

/** El tema de una pregunta: sus palabras largas, sin la «s» final (tú/usted: tienes/tiene). */
function temaDe(pregunta: string): Set<string> {
  const tema = new Set<string>();
  for (const w of normalizar(pregunta).replace(/[^a-z0-9 ]/g, " ").split(" ")) {
    const raiz = w.length > 4 ? w.replace(/s$/, "") : w;
    if (raiz.length >= 6 && !RELLENO_DE_PREGUNTA.has(w) && !RELLENO_DE_PREGUNTA.has(raiz)) tema.add(raiz);
  }
  return tema;
}

/**
 * ¿Preguntan lo mismo? Se compara el tema entero, no una palabra suelta:
 * «¿Qué negocio tienes?» y «¿Tu negocio ya tiene Instagram?» comparten
 * «negocio» y son preguntas distintas (hallazgo de Codex).
 */
function mismaPregunta(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const comunes = [...a].filter((t) => b.has(t)).length;
  return comunes / (a.size + b.size - comunes) >= 0.6;
}

/**
 * ¿Es la tercera vez seguida que pregunta lo mismo? El 31-oct-2026 a Gabriel
 * se le preguntó «¿qué negocio tiene?» en seis mensajes, mientras él pedía un
 * préstamo. La regla está en el prompt; con Muse Spark no bastó.
 */
function preguntaRepetida(texto: string, anteriores: string[]): Problema | null {
  if (anteriores.length < 2) return null;
  const previas = anteriores.slice(0, 2).map((t) => preguntasDe(t).map(temaDe));
  const repetida = preguntasDe(texto).find((p) => {
    const tema = temaDe(p);
    return previas.every((temas) => temas.some((t) => mismaPregunta(tema, t)));
  });
  if (!repetida) return null;
  return {
    codigo: "pregunta-repetida",
    gravedad: "corrige",
    frase: repetida.trim(),
    explicacion:
      "Es la tercera vez seguida que haces esta pregunta y el cliente no la contestó. No la repitas: contesta " +
      "lo que te dijo ahora, en pocas líneas, y cambia de camino (ofrécele una llamada corta con el equipo, " +
      "o deja la puerta abierta sin preguntar nada).",
  };
}

/** ¿Alguno de estos problemas impide enviar la respuesta? */
export const hayQueBloquear = (ps: Problema[]): boolean => ps.some((p) => p.gravedad === "bloquea");

/**
 * Las frases prohibidas tal como las escribe el dueño en el panel: una por
 * línea, y si quiere, el motivo después de " | " o " — ".
 *
 *   ya recibimos tu pago | eso lo confirma una persona
 *   te hago descuento — los precios son fijos
 */
export function frasesProhibidasDe(texto: string | undefined): FraseProhibida[] {
  return (texto ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [frase, ...resto] = l.split(/\s+(?:\||—|--)\s+/);
      return { frase: frase.trim(), motivo: resto.join(" ").trim() };
    })
    .filter((f) => f.frase.length >= 3);
}

/**
 * La nota que se le pasa al modelo para que rehaga la respuesta: el borrador,
 * qué tiene mal y lo que leyó en este turno, para que no tenga que volver a
 * buscarlo.
 */
export function notaDeRevision(borrador: string, problemas: Problema[], leido: string): string {
  const lista = problemas.map((p, i) => `${i + 1}. [${p.codigo}] «${p.frase}» — ${p.explicacion}`).join("\n");
  return `<revision_de_tu_respuesta>
Tu respuesta NO se envió: rompe reglas del negocio. Reescríbela entera para el cliente,
manteniendo lo que estaba bien, sin estos problemas:

${lista}

Tu borrador era:
"""
${borrador.slice(0, 3000)}
"""
${
  leido
    ? `\nLo que leíste con searchKb en este turno (ya está buscado; úsalo, no lo repitas):\n"""\n${leido.slice(0, 6000)}\n"""\n`
    : ""
}
Escribe SOLO la respuesta corregida, como si fuera la primera. No menciones esta revisión.
</revision_de_tu_respuesta>`;
}

/**
 * Lo que sale cuando la respuesta sigue rompiendo una regla que bloquea después
 * de rehacerla: corto, verdadero y sin compromisos. Quien llama abre el ticket.
 */
export const RESPUESTA_SEGURA =
  "Gracias por escribirnos. Te paso con una persona del equipo para que te lo confirme por aquí.";
