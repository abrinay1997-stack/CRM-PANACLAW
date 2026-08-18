// Tab "Costos" — cuánto cuesta operar el bot. Dos fuentes:
//  • IA (Claude/GPT): del libro `ai_usage`, que anota TODA llamada al modelo —
//    los chats y también el analista nocturno, el flywheel, los follow-ups y
//    los botones del panel. Antes solo se contaban los chats, así que el panel
//    marcaba bastante menos que la factura del proveedor.
//  • Twilio (WhatsApp + renta de números): REAL, jalado de la Usage Records API
//    de Twilio (la factura de la cuenta), no un estimado.
import type { Env } from "../../env";
import { Db } from "../../db/client";
import {layout, ico, emptyState} from "./layout";
import { usageSince, rowCost, SOURCE_LABELS, type UsageSource } from "../../db/aiUsage";
import { fetchTwilioUsage } from "../twilioUsage";
import { monthIaCostUsd, monthStartMs } from "../../budget";
import { SettingsRepo, SETTING_KEYS } from "../../db/settings";

const money = (n: number) => `$${n.toFixed(2)}`;
const money4 = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

export async function renderCosts(env: Env, saved = false): Promise<string> {
  const db = new Db(env.DB);
  const nowMs = Date.now();
  const thirtyDays = nowMs - 30 * 86_400_000;
  const monthStart = monthStartMs(nowMs);
  const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10); // UTC
  const todayStr = dayStr(nowMs);
  const thirtyStr = dayStr(thirtyDays);

  // Se pide desde el más viejo de los dos cortes para que el mes calendario
  // salga completo aunque hoy sea día 31.
  const rows = await usageSince(db, Math.min(thirtyDays, monthStart));

  let iaToday = 0;
  let ia30 = 0;
  let cacheRead30 = 0;
  let cacheWrite30 = 0;
  const byModel = new Map<string, { calls: number; input: number; output: number; cost: number }>();
  const bySource = new Map<string, { calls: number; cost: number }>();
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const cost = rowCost(r);
    if (r.day === todayStr) iaToday += cost;
    if (r.day < thirtyStr) continue;
    ia30 += cost;
    cacheRead30 += r.cacheRead;
    cacheWrite30 += r.cacheWrite;
    const m = byModel.get(r.model) ?? { calls: 0, input: 0, output: 0, cost: 0 };
    m.calls += r.calls; m.input += r.input; m.output += r.output; m.cost += cost;
    byModel.set(r.model, m);
    const src = bySource.get(r.source) ?? { calls: 0, cost: 0 };
    src.calls += r.calls; src.cost += cost;
    bySource.set(r.source, src);
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + cost);
  }

  // El mes calendario sale de la MISMA función que frena al bot cuando se
  // alcanza el tope: panel y guardia no pueden mostrar cifras distintas.
  const iaMonth = await monthIaCostUsd(db, nowMs);

  // --- Presupuesto mensual de IA ---------------------------------------------
  const budgetRaw = await new SettingsRepo(db).get(SETTING_KEYS.monthlyBudget);
  const budget = budgetRaw ? Number.parseFloat(budgetRaw) : NaN;
  const hasBudget = Number.isFinite(budget) && budget > 0;
  const monthToDate = iaMonth;
  const now = new Date(nowMs);
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = dayOfMonth > 0 ? (monthToDate / dayOfMonth) * daysInMonth : 0;
  const pct = hasBudget ? Math.min(100, Math.round((monthToDate / budget) * 100)) : 0;
  const barColor = pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--accent-2)" : "var(--accent)";

  const budgetCard = `
    <div class="card bg-panel border border-line p-[18px]">
      ${saved ? `<div class="border border-ok text-ok px-3 py-2 text-[12.5px] mb-3" style="background:var(--panel2)">✓ Presupuesto guardado.</div>` : ""}
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="font-display font-semibold text-[14px]">${ico("target")} Presupuesto mensual de IA</span>
        ${hasBudget && pct >= 100 ? `<span class="text-[9px] px-1.5 py-0.5 border border-bad text-bad">límite alcanzado — el bot bajó al modelo económico</span>` : ""}
      </div>
      ${hasBudget
        ? `
      <div class="flex items-baseline justify-between text-[12.5px] mb-2">
        <span class="text-muted">Gastado este mes: <b class="text-cream">${money(monthToDate)}</b> de ${money(budget)}</span>
        <span class="text-[11px] font-semibold" style="color:${barColor}">${pct}%</span>
      </div>
      <div style="height:12px;background:var(--panel2);border:1px solid var(--line);overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${barColor}"></div>
      </div>`
        : `<p class="text-[12.5px] text-muted mb-2 leading-relaxed">Sin límite configurado. Ponle un tope: al alcanzarlo, el bot sigue contestando pero solo con el modelo económico — nunca se queda callado ni te lleva sorpresas.</p>`}
      <p class="text-[11px] text-dim mt-2.5 mb-[14px]">Al ritmo actual, terminarás el mes en <b class="text-muted">${money(projected)}</b> de IA.</p>
      <form method="POST" action="/admin/costs/budget" class="flex items-center gap-2 flex-wrap">
        <span class="text-[12px] text-muted">Límite mensual: $</span>
        <input type="number" name="monthly_budget" min="0" step="0.5" value="${hasBudget ? budget : ""}" placeholder="25"
               style="width:90px;background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:8px 10px;font-size:12.5px;outline:none">
        <span class="text-[10.5px] text-dim">USD · deja vacío para quitar el límite</span>
        <button class="bigbtn font-display font-bold text-[12px] cursor-pointer"
          style="background:var(--accent);border:1px solid var(--accent);color:var(--on-accent);box-shadow:0 6px 18px rgba(0,0,0,.45);padding:8px 16px">Guardar</button>
      </form>
    </div>`;

  // --- Twilio: costo real del mes -------------------------------------------
  const tw = await fetchTwilioUsage(env, "ThisMonth");
  const twMonth = tw.available ? tw.total : 0;
  const totalMonth = iaMonth + twMonth;

  // --- Cards resumen ---------------------------------------------------------
  const cards = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="card bg-panel border border-line border-l-[3px] border-l-accent p-5">
        <div class="text-muted text-[11px]">Total este mes</div>
        <div class="font-display font-bold text-[30px] mt-1 leading-none">${money(totalMonth)}</div>
        <div class="text-[10px] text-dim mt-1">IA + Twilio</div>
      </div>
      <div class="card bg-panel border border-line p-5">
        <div class="text-muted text-[11px]">${ico("brain")} IA (Claude)</div>
        <div class="font-display font-bold text-[24px] mt-1.5 leading-none">${money(iaMonth)}</div>
        <div class="text-[10px] text-dim mt-1">hoy ${money4(iaToday)}</div>
      </div>
      <div class="card bg-panel border border-line p-5">
        <div class="text-muted text-[11px]">${ico("message-circle")} WhatsApp / Twilio</div>
        <div class="font-display font-bold text-[24px] mt-1.5 leading-none">${tw.available ? money(twMonth) : "—"}</div>
        <div class="text-[10px] text-dim mt-1">${tw.available ? `${tw.waConversations} conversaciones` : (tw.error ?? "no disponible")}</div>
      </div>
    </div>`;

  // --- Desglose IA por modelo ------------------------------------------------
  const modelRows = [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([model, m]) => `
      <tr style="border-top:1px solid var(--line)">
        <td class="py-2 pr-2 text-[11px] text-accent2">${esc(model)}</td>
        <td class="text-right text-cream">${m.calls}</td>
        <td class="text-right text-dim text-[11px]">${(m.input / 1000).toFixed(0)}k / ${(m.output / 1000).toFixed(0)}k</td>
        <td class="text-right font-semibold text-cream">${money4(m.cost)}</td>
      </tr>`).join("") ||
    `<tr><td colspan="4">${emptyState("receipt", "Aún no hay uso de IA")}</td></tr>`;

  const iaCard = `
    <div class="card bg-panel border border-line p-[18px]">
      <div class="font-display font-semibold text-[14px] mb-1">${ico("brain")} IA por modelo <span class="text-[10px] text-dim font-normal">(últimos 30 días)</span></div>
      <table class="w-full text-[12px] mt-2">
        <thead><tr class="text-[9.5px] tracking-[.1em] uppercase text-dim text-left"><th class="font-normal pb-2">Modelo</th><th class="font-normal text-right pb-2">Llamadas</th><th class="font-normal text-right pb-2">Tokens in/out</th><th class="font-normal text-right pb-2">Costo</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
      <p class="text-[10.5px] text-dim mt-2.5 leading-relaxed">
        De la entrada, ${(cacheRead30 / 1000).toFixed(0)}k tokens se leyeron del caché (10× más baratos)
        y ${(cacheWrite30 / 1000).toFixed(0)}k se escribieron en él (1.25× más caros). El caché dura 5 minutos:
        con tráfico espaciado casi cada respuesta lo vuelve a escribir.
      </p>
    </div>`;

  // --- Desglose IA por origen ------------------------------------------------
  // La parte que antes NO se veía: lo que gastan los trabajos automáticos.
  const sourceRows = [...bySource.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([source, v]) => `
      <tr style="border-top:1px solid var(--line)">
        <td class="py-2 pr-2 text-cream">${esc(SOURCE_LABELS[source as UsageSource] ?? source)}</td>
        <td class="text-right text-dim text-[11px]">${v.calls}</td>
        <td class="text-right font-semibold text-cream">${money4(v.cost)}</td>
      </tr>`).join("") ||
    `<tr><td colspan="3">${emptyState("receipt", "Aún no hay uso de IA")}</td></tr>`;

  const sourceCard = `
    <div class="card bg-panel border border-line p-[18px]">
      <div class="font-display font-semibold text-[14px] mb-1">${ico("target")} IA por origen <span class="text-[10px] text-dim font-normal">(últimos 30 días · ${money4(ia30)})</span></div>
      <table class="w-full text-[12px] mt-2">
        <thead><tr class="text-[9.5px] tracking-[.1em] uppercase text-dim text-left"><th class="font-normal pb-2">Origen</th><th class="font-normal text-right pb-2">Llamadas</th><th class="font-normal text-right pb-2">Costo</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table>
      <p class="text-[10.5px] text-dim mt-2.5 leading-relaxed">
        No todo el gasto viene de responder chats: el analista de insights, las mejoras y
        los follow-ups corren solos cada noche y también consumen IA.
      </p>
    </div>`;

  // --- Desglose Twilio (real) ------------------------------------------------
  const twRows = tw.available
    ? (tw.categories.length
        ? tw.categories.map((c) => `
          <tr style="border-top:1px solid var(--line)">
            <td class="py-2 pr-2 text-cream">${esc(c.label)}</td>
            <td class="text-right text-dim text-[11px]">${esc(String(c.usage))} ${esc(c.unit)}</td>
            <td class="text-right font-semibold text-cream">${money4(c.price)}</td>
          </tr>`).join("")
        : `<tr><td colspan="3" class="py-3 text-dim text-center text-[12.5px]">Sin cargos este mes.</td></tr>`)
    : `<tr><td colspan="3" class="py-3 text-dim text-center text-[12.5px]">${esc(tw.error ?? "Twilio no disponible")}</td></tr>`;

  const twSubtotal = tw.available
    ? `<div class="mt-3 text-[12px] text-muted flex justify-between" style="border-top:1px solid var(--linelit);padding-top:10px">
         <span>Mensajería ${money4(tw.messagingTotal)} · Números ${money4(tw.numbersTotal)}</span>
         <span class="font-bold text-cream">${money(twMonth)}</span>
       </div>`
    : "";

  const twCard = `
    <div class="card bg-panel border border-line p-[18px]">
      <div class="font-display font-semibold text-[14px] mb-1">${ico("message-circle")} Twilio este mes <span class="text-[10px] text-dim font-normal">— real, de tu factura de Twilio</span></div>
      <table class="w-full text-[12px] mt-2">
        <thead><tr class="text-[9.5px] tracking-[.1em] uppercase text-dim text-left"><th class="font-normal pb-2">Concepto</th><th class="font-normal text-right pb-2">Uso</th><th class="font-normal text-right pb-2">Costo</th></tr></thead>
        <tbody>${twRows}</tbody>
      </table>
      ${twSubtotal}
    </div>`;

  // --- Costo IA por día ------------------------------------------------------
  const dayRows = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 30)
    .map(([day, cost]) => `<tr style="border-top:1px solid var(--line)"><td class="py-1.5 text-muted">${esc(day)}</td><td class="text-right text-cream">${money4(cost)}</td></tr>`)
    .join("") || `<tr><td colspan="2" class="py-3 text-dim text-center text-[12.5px]">Sin datos.</td></tr>`;

  const dayCard = `
    <div class="card bg-panel border border-line p-[18px]">
      <div class="font-display font-semibold text-[14px] mb-1">${ico("calendar")} Costo de IA por día</div>
      <table class="w-full text-[12px] mt-2">
        <thead><tr class="text-[9.5px] tracking-[.1em] uppercase text-dim text-left"><th class="font-normal pb-2">Día</th><th class="font-normal text-right pb-2">Costo IA</th></tr></thead>
        <tbody>${dayRows}</tbody>
      </table>
    </div>`;

  const note = `
    <p class="text-[10.5px] text-dim leading-relaxed">
      El costo de <b class="text-muted">IA</b> se calcula con los tokens de cada llamada al modelo
      (chats y trabajos automáticos) por la tarifa publicada de ese modelo, contando aparte lo que se
      lee y lo que se escribe en caché. Debe quedar a centavos de la consola de tu proveedor; si ahí
      usas la misma llave para otra cosa, esa parte no aparece aquí.
      El de <b class="text-muted">Twilio</b> viene de la Usage Records API de Twilio: es lo que tu cuenta
      realmente gastó (incluye renta de números). Los precios de Meta por conversación de
      WhatsApp aparecen dentro de las categorías de Twilio.
    </p>`;

  const body = `
    <div class="flex flex-col gap-4" style="max-width:1080px">
      ${cards}
      ${budgetCard}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-[14px]">
        ${iaCard}
        ${twCard}
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-[14px]">
        ${sourceCard}
        ${dayCard}
      </div>
      ${note}
    </div>`;

  return layout({ title: "Costos", activeTab: "costs", body, env });
}
