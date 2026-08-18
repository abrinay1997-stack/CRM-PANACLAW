/**
 * Monthly AI budget guard.
 *
 * The owner can set `monthly_budget` (USD) from the Costos tab. When the
 * month-to-date AI spend reaches it, the agent downgrades to the "fast" tier
 * (cheap model) instead of going silent — the bot keeps answering, it just
 * stops burning money on the smart model.
 */
import { Db } from "./db/client";
import { usageCostSince } from "./db/aiUsage";
import type { Tier } from "./upgrade/modelSelector";

/** UTC start of the current month (injectable clock for tests). */
export function monthStartMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Costo de IA del mes en curso, desde el libro `ai_usage`.
 *
 * El libro incluye TODO lo que consume el proveedor — chats, analista nocturno,
 * flywheel, follow-ups y los botones del panel — así que el tope mensual frena
 * con la misma cifra que ve el dueño en su factura.
 */
export async function monthIaCostUsd(db: Db, now = Date.now()): Promise<number> {
  return usageCostSince(db, monthStartMs(now));
}

/** Pure decision: downgrade to "fast" once spend reaches the budget. */
export function applyBudgetGuard(
  tier: Tier,
  monthCostUsd: number,
  budgetUsd: number | undefined,
): { tier: Tier; downgraded: boolean } {
  if (budgetUsd === undefined || budgetUsd <= 0) return { tier, downgraded: false };
  if (monthCostUsd >= budgetUsd && tier !== "fast") {
    return { tier: "fast", downgraded: true };
  }
  return { tier, downgraded: false };
}
