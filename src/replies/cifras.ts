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
/** «$1–2 al mes»: el segundo número del rango va suelto, sin su símbolo. */
const RESTO_DEL_RANGO = /^\s*[–—-]\s*(\d[\d.,]*)/;

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
      if (resto) empujar(resto[1]);
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

export interface RespaldoDeCifras {
  /** Importes que el bot escribió sin tener de dónde copiarlos. */
  sinRespaldo: number[];
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
  }));
  const deLaRespuesta = terminosEn(respuesta, vocabulario);
  const sinRespaldo: number[] = [];

  for (const frase of frasesDe(respuesta)) {
    const importes = importesDe(frase);
    if (importes.length === 0) continue;

    // De qué se habla: lo de la frase si dice algo, y si no, lo del mensaje
    // entero — el precio suele ir en la frase siguiente a la del producto.
    const deLaFrase = terminosEn(frase, vocabulario);
    const exigidos = deLaFrase.size > 0 ? deLaFrase : deLaRespuesta;

    for (const importe of importes) {
      const respaldado = indice.some(
        (p) =>
          p.importes.has(importe) &&
          // Sin producto en juego no hay nada que cruzar: vale la cifra sola.
          (exigidos.size === 0 || [...p.terminos].some((t) => exigidos.has(t))),
      );
      if (!respaldado && !sinRespaldo.includes(importe)) sinRespaldo.push(importe);
    }
  }

  return { sinRespaldo };
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
export function avisoDeCifrasInventadas(sinRespaldo: number[]): string {
  const lista = sinRespaldo.map((n) => `$${n.toLocaleString("en-US")}`).join(", ");
  return (
    `<correccion_obligatoria>\n` +
    `Tu respuesta anterior traía ${lista} y esa cifra NO está en <business_context> ` +
    `ni en ningún resultado de searchKb de este turno, o está publicada para otro ` +
    `producto distinto del que estás hablando. Es una cifra inventada.\n\n` +
    `Vuelve a escribir la respuesta entera:\n` +
    `1. Busca el precio con searchKb ANTES de escribirlo, y cópialo tal cual.\n` +
    `2. Si la búsqueda no te lo da, NO pongas ninguna cifra: dilo y ofrece ` +
    `confirmarlo con una persona del equipo.\n` +
    `3. No ofrezcas un producto con su precio si no acabas de buscarlo.\n` +
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
