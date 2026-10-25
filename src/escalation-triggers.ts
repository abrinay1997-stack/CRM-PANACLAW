/**
 * Temas que el dueño quiere saber SIEMPRE, sin depender del criterio del modelo.
 *
 * La lección del bug anterior: cuando el aviso dependía de que el modelo
 * eligiera la tool correcta, un cliente pidió una persona, el modelo llamó a
 * pauseBot y nadie se enteró. Esto corre sobre el texto del cliente en cada
 * turno, antes del LLM y sin importar qué tools llame después. Si el modelo
 * además escala bien, el ticket es el mismo (openTicketAndNotify no duplica).
 *
 * No pausa al bot: el cliente sigue atendido mientras el dueño se entera.
 */

/** Categoría de ticket que le toca a cada tema (enum de la tabla tickets). */
type TicketCategory = "billing" | "product" | "complaint" | "other";

export interface EscalationTrigger {
  /** Identificador estable del tema. */
  id: string;
  /** Cómo se nombra en el ticket y en el aviso. */
  label: string;
  category: TicketCategory;
  patterns: RegExp[];
}

export interface TriggerMatch {
  id: string;
  label: string;
  category: TicketCategory;
  /** El texto exacto del cliente que disparó el aviso. */
  matched: string;
}

/**
 * Quita acentos y baja a minúsculas para que "cotización" y "cotizacion"
 * disparen igual. Los patrones de abajo se escriben ya sin acentos.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export const TRIGGERS: EscalationTrigger[] = [
  {
    id: "facturacion",
    label: "factura",
    category: "billing",
    patterns: [/\bfactura(s|r|cion|do|da)?\b/, /\binvoice\b/, /\bcomprobante fiscal\b/, /\bdatos de facturacion\b/],
  },
  {
    id: "contrato",
    label: "contrato",
    category: "other",
    patterns: [/\bcontrato(s)?\b/, /\bcontract\b/, /\bconvenio\b/, /\bacuerdo de servicio(s)?\b/, /\bterminos y condiciones\b/],
  },
  {
    id: "legal",
    label: "tema legal",
    category: "complaint",
    patterns: [
      /\blegal(es|mente)?\b/,
      /\babogad[oa](s)?\b/,
      /\bdemanda(r|s)?\b/,
      /\bdenuncia(r|s)?\b/,
      /\bgdpr\b/,
      /\bproteccion de datos\b/,
      /\bincumplimiento\b/,
    ],
  },
  {
    id: "reembolso",
    label: "reembolso",
    category: "billing",
    patterns: [
      /\breembols(o|ar|os|en|enme)\b/,
      /\brefund\b/,
      /\bdevolucion de(l)? dinero\b/,
      /\bdevuelva(n|me|nme)? (mi|el) dinero\b/,
      /\bquiero mi dinero\b/,
    ],
  },
  {
    id: "cotizacion",
    label: "cotización",
    category: "billing",
    patterns: [
      /\bcotiza(cion|ciones|r|me|rme)\b/,
      /\bpresupuesto(s)?\b/,
      /\bquote\b/,
      /\bpropuesta (formal|economica|comercial)\b/,
    ],
  },
  {
    id: "pago_declarado",
    label: "dice que ya pagó",
    category: "billing",
    patterns: [
      /\bya (te |les |le )?pagu[e]\b/,
      /\bya (hice|realice|efectue) (el|mi) pago\b/,
      /\bya (transferi|deposite)\b/,
      /\bhice (la|una) transferencia\b/,
      /\bpago (realizado|hecho|enviado)\b/,
      /\b(adjunto|te (mando|envio)|aqui esta) (el|mi) comprobante\b/,
      /\bcomprobante de pago\b/,
    ],
  },
  {
    id: "intencion_contratar",
    label: "quiere contratar",
    category: "product",
    patterns: [
      /\bquiero (contratar|trabajar con)\b/,
      /\bacepto (la|su) (propuesta|cotizacion|oferta)\b/,
      /\bcuando (empezamos|arrancamos|iniciamos)\b/,
      /\b(vamos|procedamos) a proceder\b/,
      /\bdonde firmo\b/,
      /\bcomo (procedo|hago) para contratar\b/,
      /\blo quiero contratar\b/,
    ],
  },
  {
    id: "pide_humano",
    label: "pide una persona",
    category: "other",
    patterns: [
      /\bhuman[oa](s)?\b/,
      /\bcon una persona\b/,
      /\bpersona real\b/,
      /\breal person\b/,
      /\basesor(a|es)?\b/,
      /\bagente\b/,
      /\brepresentante\b/,
      /\balguien del equipo\b/,
      /\bhablar con alguien\b/,
      /\b(el|la) duen[oa]\b/,
      /\bencargad[oa]\b/,
    ],
  },
];

/** El marcador que `ingest` le pone al texto cuando el cliente manda imagen. */
const IMAGE_MARKERS = [/\[image_url: /, /\bel cliente mando una imagen\b/];
/** Lo mismo con un documento (WhatsApp Cloud lo marca; el canal por QR lo describe). */
const DOCUMENT_MARKERS = [/\[documento: /, /\bel cliente mando un documento\b/];

/**
 * ¿Este mensaje del cliente amerita avisarle al dueño?
 *
 * Devuelve el PRIMER tema que dispara (el orden de TRIGGERS manda) o null.
 * `extraKeywords` son las palabras que el dueño escribió en Config →
 * "Palabras que piden un humano"; se buscan como subcadena, tal cual las puso.
 */
export function detectEscalation(
  text: string,
  extraKeywords: string[] = [],
): TriggerMatch | null {
  // El anuncio del que llegó la persona lo escribió el negocio, no ella: si
  // dice «cotiza» o «contrata», no es un tema que el dueño tenga que atender.
  const raw = (text ?? "").replace(/\n?\[ANUNCIO: [^\]]*\]/g, "");
  const norm = normalize(raw);
  if (!norm.trim()) return null;

  // Una imagen suele ser un comprobante, una factura o un error que el cliente
  // no sabe describir. Al dueño le sirve verla aunque el texto no diga nada.
  if (IMAGE_MARKERS.some((m) => m.test(norm))) {
    return {
      id: "adjunto",
      label: "mandó una imagen",
      category: "other",
      matched: stripMarkers(raw) || "(imagen sin texto)",
    };
  }

  // Un documento es, casi siempre, una factura o un comprobante en PDF.
  if (DOCUMENT_MARKERS.some((m) => m.test(norm))) {
    return {
      id: "adjunto",
      label: "mandó un documento",
      category: "other",
      matched: stripMarkers(raw) || "(documento sin texto)",
    };
  }

  for (const trigger of TRIGGERS) {
    for (const pattern of trigger.patterns) {
      const hit = norm.match(pattern);
      if (hit) {
        return {
          id: trigger.id,
          label: trigger.label,
          category: trigger.category,
          matched: hit[0],
        };
      }
    }
  }

  // Las del dueño van al final: las genéricas de arriba ya cubren lo común, y
  // así una palabra suya no le roba la etiqueta buena a un tema conocido.
  for (const keyword of extraKeywords) {
    const k = normalize(keyword).trim();
    if (k && norm.includes(k)) {
      return { id: "palabra_clave", label: `palabra clave "${keyword}"`, category: "other", matched: keyword };
    }
  }

  return null;
}

/** Deja el texto legible para el ticket: sin marcador de imagen y acotado. */
export function stripMarkers(text: string, max = 200): string {
  const clean = text
    .replace(/\n?\[IMAGE_URL: .+?\]/gi, "")
    .replace(/\n?\[ANUNCIO: [^\]]*\]/g, "")
    .replace(/\[DOCUMENTO: \S+? \| ([^\]]*)\]/g, "(documento: $1)")
    .replace(/\[DOCUMENTO: [^\]]*\]/g, "(documento)")
    .replace(/\n?\(El cliente mandó una imagen[^)]*\)/gi, "")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
