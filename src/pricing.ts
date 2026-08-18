// USD per million tokens. Update when providers adjust pricing.
//
// Anthropic cobra la caché en DOS conceptos distintos y hay que separarlos o el
// costo sale bajo: leer del caché cuesta 0.1× la entrada, pero ESCRIBIRLO
// cuesta 1.25×. Con tráfico esporádico (el caché vive 5 minutos) casi cada
// mensaje re-escribe el prompt del sistema, así que la escritura NO es un
// detalle: es la mayor parte de la entrada facturada.
export const PRICING = {
  haiku: {
    input: 1.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5.0,
  },
  sonnet: {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  // OpenAI alternative (defaults mapped in src/llm/provider.ts). OpenAI no cobra
  // por escribir en caché: la escritura vale lo mismo que la entrada normal.
  "gpt-4o-mini": {
    input: 0.15,
    cacheRead: 0.075,
    cacheWrite: 0.15,
    output: 0.60,
  },
  "gpt-4o": {
    input: 2.50,
    cacheRead: 1.25,
    cacheWrite: 2.50,
    output: 10.00,
  },
} as const;

interface Rates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

// Concrete model ids we price natively. Unknown ids fall back to the cheapest
// rate (Haiku) so cost logging never throws — it just under/over-estimates.
const RATES: Record<string, Rates> = {
  "claude-haiku-4-5-20251001": PRICING.haiku,
  "claude-sonnet-4-5-20250929": PRICING.sonnet,
  "gpt-4o-mini": PRICING["gpt-4o-mini"],
  "gpt-4o": PRICING["gpt-4o"],
  // BYO-LLM picker (dashboard "Modelo de IA")
  "claude-sonnet-4-6": PRICING.sonnet,
  "claude-opus-4-6": { input: 5.0, cacheRead: 0.5, cacheWrite: 6.25, output: 25.0 },
  "gpt-4.1": { input: 2.0, cacheRead: 0.5, cacheWrite: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cacheRead: 0.1, cacheWrite: 0.4, output: 1.6 },
  "grok-4": { input: 3.0, cacheRead: 0.75, cacheWrite: 3.0, output: 15.0 },
  "grok-4-fast-non-reasoning": { input: 0.2, cacheRead: 0.05, cacheWrite: 0.2, output: 0.5 },
  "grok-3-mini": { input: 0.3, cacheRead: 0.075, cacheWrite: 0.3, output: 0.5 },
};

// Any concrete model id string (Anthropic or OpenAI). Kept as a string alias so
// env-overridden / custom models still type-check at call sites.
export type ModelId = string;

export interface Usage {
  /** Entrada TOTAL del proveedor: incluye lo leído y lo escrito en caché. */
  input: number;
  /** Tokens servidos desde el caché (baratos). */
  cached: number;
  /** Tokens escritos al caché (con recargo). Opcional: histórico sin el dato. */
  cacheWrite?: number;
  output: number;
}

export function costOfUsage(model: ModelId, usage: Usage): number {
  const rates = RATES[model] ?? PRICING.haiku;
  const cacheWrite = usage.cacheWrite ?? 0;
  // `input` viene como total; lo que no fue caché es entrada fresca. El clamp
  // evita negativos si un proveedor reporta los tres campos por separado.
  const fresh = Math.max(0, usage.input - usage.cached - cacheWrite);
  return (
    fresh * (rates.input / 1_000_000) +
    usage.cached * (rates.cacheRead / 1_000_000) +
    cacheWrite * (rates.cacheWrite / 1_000_000) +
    usage.output * (rates.output / 1_000_000)
  );
}
