/**
 * Libro de gasto de IA (tabla `ai_usage`).
 *
 * TODA llamada al modelo se anota aquí — el chat y también los trabajos que el
 * cliente no ve: el analista nocturno, el flywheel, los follow-ups y los
 * botones del panel. Sin esto, el panel solo contaba los chats y el resto
 * aparecía únicamente en la factura del proveedor.
 *
 * Guardamos TOKENS, no dinero: el precio se aplica al leer (`costOfUsage`), de
 * modo que corregir una tarifa arregla también el histórico.
 */
import { Db } from "./client";
import { costOfUsage, type ModelId } from "../pricing";

/** De dónde salió la llamada. Se muestra tal cual en el panel de Costos. */
export type UsageSource =
  | "chat"
  | "insights"
  | "flywheel"
  | "followup"
  | "suggest"
  | "test";

export const SOURCE_LABELS: Record<UsageSource, string> = {
  chat: "Conversaciones",
  insights: "Analista de insights",
  flywheel: "Mejoras (flywheel)",
  followup: "Follow-ups",
  suggest: "Sugerir respuesta",
  test: "Prueba de modelo",
};

export interface TokenUsage {
  /** Entrada TOTAL: incluye lo leído y lo escrito en caché. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Normaliza el `usage` del AI SDK.
 *
 * Ojo con dos trampas del SDK:
 *  • `inputTokens` ya es el TOTAL (fresco + leído + escrito en caché).
 *  • en `streamText`, `result.usage` es solo el ÚLTIMO paso — para una respuesta
 *    con herramientas hay que usar `result.totalUsage`.
 */
export function usageFromSdk(u: unknown): TokenUsage {
  const usage = (u ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  const details = usage.inputTokenDetails ?? {};
  return {
    input: usage.inputTokens ?? 0,
    cacheRead: details.cacheReadTokens ?? usage.cachedInputTokens ?? 0,
    cacheWrite: details.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
  };
}

export interface RecordUsageInput {
  /** Para los chats es el id del mensaje: hace el registro idempotente. */
  id?: string;
  source: UsageSource;
  conversationId?: string | null;
  model: string;
  usage: TokenUsage;
  createdAt?: number;
}

/**
 * Anota una llamada. Nunca lanza: la contabilidad no puede tumbar al bot ni
 * dejar sin respuesta a un cliente.
 */
export async function recordAiUsage(db: Db, input: RecordUsageInput): Promise<void> {
  const { usage } = input;
  if (!input.model) return;
  if (usage.input <= 0 && usage.output <= 0) return;
  try {
    await db.run(
      `INSERT OR IGNORE INTO ai_usage (
         id, source, conversation_id, model,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id ?? crypto.randomUUID(),
        input.source,
        input.conversationId ?? null,
        input.model,
        Math.round(usage.input),
        Math.round(usage.cacheRead),
        Math.round(usage.cacheWrite),
        Math.round(usage.output),
        input.createdAt ?? Date.now(),
      ],
    );
  } catch (e) {
    console.error("[ai_usage] no se pudo anotar el gasto:", e);
  }
}

export interface UsageRow {
  day: string;
  model: string;
  source: string;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Filas agrupadas por (día, modelo, origen) desde `sinceMs`. */
export async function usageSince(db: Db, sinceMs: number): Promise<UsageRow[]> {
  return db.all<UsageRow>(
    `SELECT date(created_at / 1000, 'unixepoch') as day,
            model, source,
            COUNT(*) as calls,
            SUM(input_tokens) as input,
            SUM(cache_read_tokens) as cacheRead,
            SUM(cache_write_tokens) as cacheWrite,
            SUM(output_tokens) as output
     FROM ai_usage
     WHERE created_at >= ?
     GROUP BY day, model, source
     ORDER BY day DESC`,
    [sinceMs],
  );
}

/** Costo de una fila del libro, con las tarifas de hoy. */
export function rowCost(row: Pick<UsageRow, "model" | "input" | "cacheRead" | "cacheWrite" | "output">): number {
  return costOfUsage(row.model as ModelId, {
    input: row.input,
    cached: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
  });
}

/** Costo total de IA desde `sinceMs`. */
export async function usageCostSince(db: Db, sinceMs: number): Promise<number> {
  const rows = await db.all<Omit<UsageRow, "day" | "source" | "calls">>(
    `SELECT model,
            SUM(input_tokens) as input,
            SUM(cache_read_tokens) as cacheRead,
            SUM(cache_write_tokens) as cacheWrite,
            SUM(output_tokens) as output
     FROM ai_usage
     WHERE created_at >= ?
     GROUP BY model`,
    [sinceMs],
  );
  return rows.reduce((total, row) => total + rowCost(row), 0);
}

/** Suelta el vínculo con una conversación borrada, conservando el gasto. */
export async function detachConversation(db: Db, conversationId: string): Promise<void> {
  await db.run("UPDATE ai_usage SET conversation_id = NULL WHERE conversation_id = ?", [
    conversationId,
  ]);
}
