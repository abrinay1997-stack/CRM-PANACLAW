/**
 * Guardia de cifras: ninguna cantidad de dinero sale del bot si no estaba
 * escrita —tal cual, y junto a lo que se está hablando— en algo que el bot leyó
 * en este mismo turno.
 *
 * POR QUÉ EXISTE
 * --------------
 * El prompt ya pide no inventar precios, con todas las letras y en tres sitios
 * distintos. Un cliente preguntó si las páginas se hacen con IA y el bot, que
 * no tenía ese dato, improvisó la respuesta entera y de paso ofreció el chatbot
 * "por $70 pago único". El precio publicado es $499. Nadie lo detectó hasta que
 * el dueño leyó la conversación.
 *
 * Un ruego dentro del prompt no es una defensa: se cumple casi siempre, y el
 * "casi" lo paga el cliente que repite la cifra equivocada. Esto sí lo es,
 * porque no depende de que el modelo se porte bien.
 *
 * POR QUÉ NO BASTA UNA LISTA BLANCA DE IMPORTES
 * ---------------------------------------------
 * El sitio publica la lista de todas sus cifras (`web-precios`) precisamente
 * para bloquear las inventadas. Con este fallo no habría servido: $70 SÍ está
 * publicado — es el piso de Web Blindada, el plan de seguridad mensual. La
 * cifra era real; lo inventado fue pegársela a otro producto.
 *
 * Por eso aquí no se valida el número solo, sino el número CON su producto: un
 * importe está respaldado si existe un pasaje —una línea del contexto del
 * negocio, un resultado de searchKb— que traiga esa cifra Y hable de lo mismo
 * que la respuesta. El $70 de Web Blindada no respalda un $70 de eBot, y la
 * lista blanca —que enumera importes sin decir de qué es cada uno— no respalda
 * nada, que es exactamente lo que se busca.
 *
 * QUÉ NO HACE
 * -----------
 * No mira porcentajes ("50 % al arrancar"), ni plazos, ni cantidades sin
 * moneda: solo dinero. Y ante la duda respalda, no bloquea — una respuesta
 * correcta que no sale es un cliente sin atender, y eso también cuesta.
 */

/** Frases con las que se escribe dinero por aquí. */
const MONEDA_ANTES = /(?:US\$|USD\s*\$?|B\/\.|\$)\s?(\d[\d.,]*)/gi;
const MONEDA_DESPUES = /(\d[\d.,]*)\s*(?:d[oó]lares|usd|balboas)\b/gi;
/**
 * «$1–2 al mes»: el segundo número del rango va suelto, sin su símbolo.
 *
 * Pero una raya después de un precio casi nunca es un rango: es como escribe
 * el modelo. «PanaClaw Start: $295 — 72 horas» se leía como «de $295 a $72»,
 * el 72 salía como precio inventado y el cliente que llegó del anuncio recibía
 * «prefiero no darte un número» en vez del plan (25-oct-2026). Por eso el
 * número que sigue a la raya no cuenta si lleva una unidad que no es dinero
 * (horas, días, %, secciones…); y en `importesDe`, tampoco si es menor que el
 * primero, porque un rango va de menos a más.
 */
const RESTO_DEL_RANGO =
  /^\s*[–—-]\s*(\d[\d.,]*)(?![\d.,])(?!\s*(?:%|h\b|hrs?\b|horas?\b|d[ií]as?\b|semanas?\b|mes(?:es)?\b|a[nñ]os?\b|secciones\b|p[aá]ginas?\b|cambios\b|rondas?\b))/i;

/**
 * Pasa "1,200" / "$499." / "70" a un número comparable.
 * Formato de la región: coma para miles, punto para decimales.
 */
function aNumero(bruto: string): number | null {
  const limpio = bruto.replace(/,/g, "").replace(/\.$/, "");
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** Toda cantidad de dinero que aparece en un texto, normalizada a número. */
export function importesDe(texto: string): number[] {
  const out: number[] = [];
  const empujar = (bruto: string) => {
    const n = aNumero(bruto);
    if (n !== null) out.push(n);
  };

  for (const re of [MONEDA_ANTES, MONEDA_DESPUES]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(texto)) !== null) {
      empujar(m[1]);
      // El otro extremo de un rango escrito con un solo símbolo.
      const resto = RESTO_DEL_RANGO.exec(texto.slice(m.index + m[0].length));
      const desde = aNumero(m[1]);
      const hasta = resto ? aNumero(resto[1]) : null;
      if (resto && desde !== null && hasta !== null && hasta > desde) empujar(resto[1]);
    }
  }
  return out;
}

/** Sin acentos y en minúsculas: "Auditoría" y "auditoria" son la misma palabra. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Palabras demasiado corrientes para distinguir un producto de otro. No son
 * "palabras vacías" del idioma: son las que aparecen en los nombres de los
 * servicios de cualquier negocio y no dicen de cuál se habla.
 */
const CORRIENTES = new Set([
  "pago",
  "unico",
  "mensual",
  "mensuales",
  "plan",
  "planes",
  "precio",
  "precios",
  "desde",
  "hasta",
  "para",
  "con",
  "sin",
  "una",
  "sola",
  "solo",
  "todo",
  "todos",
  "otro",
  "otros",
  "cada",
  "segun",
  "sueltas",
  "sueltos",
  "cual",
  "cuales",
]);

/**
 * El vocabulario que distingue un servicio de otro, sacado de los nombres
 * publicados en la configuración del negocio.
 *
 * Se descartan dos cosas. El nombre del negocio, que va repetido en casi todos
 * los planes ("PanaClaw Start", "PanaClaw Care"): una palabra que está en todos
 * no separa nada, y si contara, cualquier pasaje respaldaría cualquier cifra.
 * Y lo que aun así aparezca en la mitad o más de los nombres, por lo mismo.
 *
 * @param nombres  Nombres de servicio, tal como los publica el negocio.
 * @param excluir  Nombre del negocio (se parte en palabras y se ignora entero).
 */
export function vocabularioDeServicios(nombres: string[], excluir = ""): string[] {
  const propias = new Set(
    normalizar(excluir)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const porNombre = nombres.map(
    (n) =>
      new Set(
        normalizar(n)
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 4 && !CORRIENTES.has(t) && !propias.has(t)),
      ),
  );
  const frecuencia = new Map<string, number>();
  for (const set of porNombre) {
    for (const t of set) frecuencia.set(t, (frecuencia.get(t) ?? 0) + 1);
  }
  const techo = Math.max(1, Math.ceil(nombres.length / 2));
  return [...frecuencia].filter(([, n]) => n < techo).map(([t]) => t);
}

/** Qué palabras del vocabulario aparecen en un texto. */
function terminosEn(texto: string, vocabulario: string[]): Set<string> {
  const plano = normalizar(texto);
  const out = new Set<string>();
  for (const t of vocabulario) {
    // Con frontera de palabra: "care" no debe activarse dentro de "carecer".
    if (new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).test(plano)) out.add(t);
  }
  return out;
}

/** Se corta por frase para que cada cifra se juzgue con lo que la rodea. */
function frasesDe(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Las frases de una FUENTE. A diferencia de `frasesDe`, no se corta en «:»:
 * en el contexto del negocio el nombre del servicio va antes de los dos puntos
 * («Seguridad mensual (…): $30–$60/mes»), y separarlo dejaría la cifra suelta,
 * como si fuera un dato general.
 */
function frasesDeFuente(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Palabras que no dicen de qué se habla: las de hablar de dinero y las de
 * cualquier conversación. Se descartan para cruzar un dato general por lo que
 * dice («dominio», «renueva») y no por cómo se pregunta («cuesta», «tienes»).
 */
const DE_RELLENO = new Set([
  "cuesta",
  "cuestan",
  "costo",
  "costos",
  "costar",
  "cobra",
  "cobran",
  "cobramos",
  "pagas",
  "pagar",
  "pagan",
  "pagos",
  "valor",
  "valen",
  "salen",
  "dolar",
  "dolares",
  "balboas",
  "aproximadamente",
  "alrededor",
  "entre",
  "nuestro",
  "nuestra",
  "nuestros",
  "nuestras",
  "tiene",
  "tienes",
  "tienen",
  "puede",
  "puedes",
  "pueden",
  "tener",
  "hacer",
  "hacemos",
  "negocio",
  "cliente",
  "clientes",
  "incluye",
  "incluyen",
  "incluido",
  "incluida",
  "incluidos",
  "incluidas",
  "aparte",
  "ademas",
  "tambien",
  "quieres",
  "necesitas",
  "mensualidad",
  "anual",
  "total",
  "porque",
  "donde",
  "cuando",
  "sobre",
  "estos",
  "estas",
  "primero",
  "primera",
  "siempre",
  "ahora",
  "luego",
  "despues",
  "cuanto",
  "cuanta",
  "cuantos",
  "cuantas",
  "solamente",
  "unicamente",
  "queda",
  "quedan",
  "sitios",
  "publicado",
  "publicados",
  "publicada",
  "publicadas",
  "cuenta",
  "quede",
  "responde",
]);

/** Las palabras de una frase que sí dicen de qué habla. */
function palabrasDe(texto: string): Set<string> {
  return new Set(
    normalizar(texto)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 5 && !/^\d+$/.test(t) && !CORRIENTES.has(t) && !DE_RELLENO.has(t)),
  );
}

/**
 * Las frases de una fuente que dan una cifra sin hablar de ningún servicio:
 * «lo único que se renueva es el dominio, unos $15 al año». Respaldan esa
 * cifra cuando la respuesta habla de lo mismo, aunque la respuesta esté
 * hablando de un plan.
 *
 * Sin esto, el bot que contestaba «el Start cuesta $295… y el dominio, unos
 * $15 al año» —copiado tal cual de la web— salía bloqueado: el trozo del
 * dominio no nombra el Start. Una enumeración de cifras (la lista blanca de
 * `web-precios`, con veinte importes en una frase) no es un dato: no dice de
 * qué es ninguna, y no respalda nada.
 */
function datosGenerales(
  pasaje: string,
  vocabulario: string[],
): { importes: Set<number>; palabras: Set<string> }[] {
  const out: { importes: Set<number>; palabras: Set<string> }[] = [];
  for (const frase of frasesDeFuente(pasaje)) {
    const importes = new Set(importesDe(frase));
    if (importes.size === 0 || importes.size > 3) continue;
    if (terminosEn(frase, vocabulario).size > 0) continue;
    out.push({ importes, palabras: palabrasDe(frase) });
  }
  return out;
}

export interface RespaldoDeCifras {
  /** Importes que el bot escribió sin tener de dónde copiarlos. */
  sinRespaldo: number[];
  /** Las frases de la respuesta donde están, tal como las escribió. */
  frases: string[];
}

/**
 * Revisa una respuesta contra las fuentes que el bot tuvo delante en el turno.
 *
 * @param respuesta   Lo que el bot va a mandar.
 * @param pasajes     Contexto del negocio y resultados de searchKb, un texto
 *                    por pasaje (el título cuenta: lleva de qué habla el trozo).
 * @param vocabulario Palabras que distinguen un servicio de otro.
 */
export function revisarCifras(
  respuesta: string,
  pasajes: string[],
  vocabulario: string[],
): RespaldoDeCifras {
  const indice = pasajes.map((p) => ({
    importes: new Set(importesDe(p)),
    terminos: terminosEn(p, vocabulario),
    generales: datosGenerales(p, vocabulario),
  }));
  const deLaRespuesta = terminosEn(respuesta, vocabulario);
  const sinRespaldo: number[] = [];
  const frases: string[] = [];

  for (const frase of frasesDe(respuesta)) {
    const importes = importesDe(frase);
    if (importes.length === 0) continue;

    // De qué se habla: lo de la frase si dice algo, y si no, lo del mensaje
    // entero — el precio suele ir en la frase siguiente a la del producto.
    const deLaFrase = terminosEn(frase, vocabulario);
    const exigidos = deLaFrase.size > 0 ? deLaFrase : deLaRespuesta;
    const palabras = palabrasDe(frase);

    for (const importe of importes) {
      const respaldado = indice.some(
        (p) =>
          (p.importes.has(importe) &&
            // Sin producto en juego no hay nada que cruzar: vale la cifra sola.
            (exigidos.size === 0 || [...p.terminos].some((t) => exigidos.has(t)))) ||
          // Un dato general de la fuente («el dominio, unos $15 al año»), si
          // la frase habla de lo mismo.
          p.generales.some((g) => g.importes.has(importe) && [...g.palabras].some((w) => palabras.has(w))),
      );
      if (respaldado) continue;
      if (!sinRespaldo.includes(importe)) sinRespaldo.push(importe);
      if (!frases.includes(frase)) frases.push(frase);
    }
  }

  return { sinRespaldo, frases };
}

/**
 * La respuesta sin las frases que traen una cifra sin respaldo.
 *
 * Es lo que hace Juan en D'Casa cuando el modelo insiste: se quita la oración
 * y el resto sale. Antes, aquí se tiraba la respuesta ENTERA y el cliente que
 * preguntaba por un plan recibía «prefiero no darte un número…» en lugar de
 * todo lo que sí estaba bien. Devuelve "" si no queda nada que valga la pena
 * mandar.
 */
export function sinFrasesSinRespaldo(respuesta: string, frases: string[]): string {
  let texto = respuesta;
  for (const f of frases) texto = texto.split(f).join("");
  const limpio = texto
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").trimEnd())
    // Una viñeta o un número de lista que quedó solo, sin nada detrás.
    .filter((l) => !/^\s*(?:[-*•]|\d+[.)])?\s*$/.test(l) || l === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return /\p{L}{3,}.*\p{L}{3,}/su.test(limpio) && limpio.length >= 20 ? limpio : "";
}

/**
 * Lo que devolvió una herramienta, convertido en pasajes legibles.
 *
 * Solo cuentan las herramientas que traen datos del negocio: `searchKb` (la
 * web) y `catalogQuery` (el catálogo del dueño). El catálogo guarda el precio
 * como número pelado —`{ name: "Camisa", price: 25 }`— y sin símbolo aquí no
 * se vería como dinero: el bot citaría un precio real de su propio catálogo y
 * esto lo tomaría por inventado. Se rearma con su moneda.
 */
export function pasajesDeHerramienta(nombre: string, salida: any): string[] {
  if (nombre === "searchKb") {
    return ((salida?.results ?? []) as any[]).map(
      (r) => `${r?.title ?? ""}\n${r?.content ?? ""}`,
    );
  }
  if (nombre === "catalogQuery") {
    return ((salida?.matches ?? []) as any[]).map((p) =>
      [p?.name, p?.sku, p?.description, p?.price !== undefined ? `$${p.price}` : ""]
        .filter(Boolean)
        .join(" — "),
    );
  }
  return [];
}

export interface FuentesDelTurno {
  /** Un texto por pasaje: cada línea del contexto y cada trozo de la KB. */
  pasajes: string[];
  /** Palabras que distinguen un servicio de otro en ESTE negocio. */
  vocabulario: string[];
}

/**
 * Lo que el bot tenía delante sin buscar: el bloque <business_context> del
 * prompt, partido en líneas.
 *
 * Se lee del prompt ya montado y no de `member/config.local.ts` a propósito: el
 * panel puede sobreescribir ese contexto entero (Config → "Información del
 * negocio"), y validar contra el archivo dejaría al bot bloqueando los precios
 * que el propio dueño acaba de escribir en el panel. Se valida contra lo que el
 * bot leyó, que es lo único que de verdad tuvo delante.
 *
 * El vocabulario sale de los nombres de las líneas que llevan dinero
 * ("eBot (chatbot con IA): $499 pago único" → eBot, chatbot). Es lo que permite
 * saber que un $70 de seguridad no respalda un $70 de chatbot.
 */
export function fuentesDelPrompt(systemPrompt: string, nombreDelNegocio = ""): FuentesDelTurno {
  const bloque = /<business_context>([\s\S]*?)<\/business_context>/.exec(systemPrompt);
  const pasajes = (bloque?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const nombres = pasajes
    .filter((l) => importesDe(l).length > 0 && l.includes(":"))
    .map((l) => l.slice(0, l.indexOf(":")));
  return { pasajes, vocabulario: vocabularioDeServicios(nombres, nombreDelNegocio) };
}

/** Cómo se le dice al modelo que se inventó una cifra, para que se corrija. */
export function avisoDeCifrasInventadas(sinRespaldo: number[], conImagen = false, frases: string[] = []): string {
  const lista = sinRespaldo.map((n) => `$${n.toLocaleString("en-US")}`).join(", ");
  // La frase exacta: con solo el número, el modelo no siempre encuentra qué
  // corregir, y vuelve a escribir lo mismo.
  const donde = frases.length
    ? `\nLo que hay que corregir:\n${frases.map((f) => `- «${f}»`).join("\n")}\n`
    : "";
  return (
    `<correccion_obligatoria>\n` +
    `Tu respuesta anterior traía ${lista} y esa cifra NO está en <business_context> ` +
    `ni en ningún resultado de searchKb de este turno, o está publicada para otro ` +
    `producto distinto del que estás hablando. Es una cifra inventada.\n${donde}\n` +
    `Lo demás de tu respuesta puede quedarse igual: cambia solo eso.\n\n` +
    `Vuelve a escribir la respuesta entera:\n` +
    `1. Busca el precio con searchKb ANTES de escribirlo, y cópialo tal cual.\n` +
    `2. Si la búsqueda no te lo da, NO pongas ninguna cifra: dilo y ofrece ` +
    `confirmarlo con una persona del equipo.\n` +
    `3. No ofrezcas un producto con su precio si no acabas de buscarlo.\n` +
    (conImagen
      ? `4. El cliente mandó una imagen (quizá un comprobante): confirma que la recibiste ` +
        `y que el equipo la revisa, SIN repetir montos leídos de la imagen.\n`
      : "") +
    `</correccion_obligatoria>`
  );
}

/**
 * Lo que se manda si el modelo insiste en la cifra inventada.
 *
 * Se prefiere quedar corto a quedar mal: un cliente que repite un precio que no
 * cobramos es un problema real, y deshacerlo cuesta más que no haberlo dicho.
 */
export const RESPUESTA_SIN_CIFRA =
  "Prefiero no darte un número que no tenga confirmado — mejor eso que decirte " +
  "una cifra equivocada. Deja que te lo confirme una persona del equipo y te " +
  "responde con el dato exacto.";

/**
 * Lo mismo, cuando el cliente mandó una foto: casi siempre un comprobante. Un
 * "no te doy un número" ahí no contesta nada; lo que sirve es acusar recibo.
 */
export const RESPUESTA_SIN_CIFRA_CON_IMAGEN =
  "¡Recibido! 👍 Ya le pasé tu imagen al equipo para que la revise; en cuanto " +
  "la confirmen te escriben por aquí.";
