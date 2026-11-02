import type { Env } from "./env";
import { Db } from "./db/client";
import { SettingsRepo, SETTING_KEYS } from "./db/settings";
import { systemPromptFromEnv, type FormaDeTrato } from "./system-prompt";
import { contextoSemilla, enlacesDelContexto } from "./businessContext";
import { getBufferMs } from "./config";
import { getNiche } from "./niches";
import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_TIMEZONE,
  parseBusinessHours,
  type BusinessHours,
} from "./hours";
import type { LlmOverrides } from "./llm/provider";
import { frasesProhibidasDe, type FraseProhibida } from "./replies/revisor";

export type ModelOverride = "auto" | "haiku" | "sonnet";

export interface AgentConfig {
  systemPrompt: string;
  bufferMs: number;
  maxChunks: number;
  interChunkDelayMs: number;
  modelOverride: ModelOverride;
  botPaused: boolean;
  /** Tool names still enabled after applying the dashboard's disabled_tools. */
  enabledToolNames: string[];
  /** Sampling temperature (0-1). undefined = use the provider default. */
  temperature?: number;
  /** Monthly AI budget (USD). undefined = no cap. */
  monthlyBudgetUsd?: number;
  /** Zona horaria del negocio (IANA). Decide qué hora es "de día" para él. */
  timezone: string;
  /**
   * Horario laboral del negocio. Acota los mensajes que nadie pidió
   * (seguimientos) y le dice al bot si ahora mismo hay alguien del equipo.
   * Responder no depende de esto: quien escribe de madrugada recibe
   * respuesta de madrugada.
   */
  businessHours: BusinessHours;
  /** BYO-LLM del dashboard (proveedor / API key / modelo). */
  llm: LlmOverrides;
  /**
   * Palabras del panel ("Palabras que piden un humano"). Van al prompt y
   * TAMBIÉN al detector determinista (src/escalation-triggers.ts): el aviso al
   * dueño no puede depender de que el modelo haga caso.
   */
  escalationKeywords: string[];
  /** Frases que el bot nunca dice (panel → Config). Las vigila el revisor. */
  frasesProhibidas: FraseProhibida[];
  /** Nombre del bot (panel → Config, o BOT_NAME). Lo usa el seguimiento. */
  botName?: string;
  /** Tono del panel. Lo usa el seguimiento, que no pasa por el prompt entero. */
  tone?: string;
  /**
   * Usted o tú (Configuración → Trato al cliente; de usted si no se eligió).
   * Lo vigilan el revisor y el seguimiento.
   */
  formaDeTrato?: FormaDeTrato;
}

/** «usted» o «tu»; cualquier otra cosa es «sin elegir». */
export function normalizarTrato(value: string | undefined): FormaDeTrato | undefined {
  const v = value?.trim().toLowerCase();
  return v === "usted" || v === "tu" ? v : undefined;
}

/** Extract the BYO-LLM overrides from a settings snapshot. */
export function llmOverridesFrom(settings: Record<string, string>): LlmOverrides {
  const pick = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v.trim() : undefined;
  };
  return {
    provider: pick(SETTING_KEYS.llmProvider),
    apiKey: pick(SETTING_KEYS.llmApiKey),
    model: pick(SETTING_KEYS.llmModel),
  };
}

/** Load just the BYO-LLM overrides (para analyzer/flywheel/admin, fuera del agente).
 *  Nunca truena: si settings no está disponible, se usan los defaults del env. */
export async function loadLlmOverrides(env: Env): Promise<LlmOverrides> {
  try {
    const settings = await new SettingsRepo(new Db(env.DB)).all();
    return llmOverridesFrom(settings);
  } catch {
    return {};
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function normalizeModelOverride(value: string | undefined): ModelOverride {
  if (value === "haiku" || value === "sonnet" || value === "auto") return value;
  return "auto";
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * La Información del negocio que lee el bot: la del PANEL, y solo esa.
 *
 * Antes, si el panel estaba vacío, el bot leía member/config.local.ts, y los
 * enlaces salían de ahí siempre. Eran dos fuentes y se desincronizaron: el
 * panel seguía dando el WhatsApp de EE. UU. que el repo ya había cambiado por
 * el de Panamá, y decía «sin reuniones presenciales» cuando el repo decía lo
 * contrario. El dueño pidió una sola fuente, la de la aplicación (25-oct-2026).
 *
 * Lo del repo queda como SEMILLA: si el panel nunca tuvo texto, se copia ahí
 * una vez y se anota que ya se sembró. Desde ese momento manda el panel, aunque
 * el dueño lo deje vacío.
 */
export async function contextoDelNegocio(env: Env, settings?: Record<string, string>): Promise<string> {
  const repo = new SettingsRepo(new Db(env.DB));
  let s = settings;
  if (!s) {
    try {
      s = await repo.all();
    } catch (e) {
      // Sin D1 no hay de dónde leer. Vacío, y no el repo: el panel es la
      // única fuente, también cuando falla.
      console.warn("[contexto] no se pudo leer la Información del negocio:", e);
      return "";
    }
  }
  const delPanel = (s[SETTING_KEYS.businessContext] ?? "").trim();
  if (delPanel || s[SETTING_KEYS.contextoSembrado] === "1") return delPanel;
  const semilla = contextoSemilla();
  try {
    if (semilla) await repo.set(SETTING_KEYS.businessContext, semilla);
    await repo.set(SETTING_KEYS.contextoSembrado, "1");
  } catch (e) {
    // Sembrar es un extra: si D1 falla, se contesta igual con la semilla.
    console.warn("[contexto] no se pudo sembrar la Información del negocio en el panel:", e);
  }
  return semilla;
}

/**
 * Resolve the effective agent config by overlaying D1 `settings` on top of env
 * defaults. Anything empty/absent in settings falls back to the env/default.
 */
export async function resolveAgentConfig(env: Env, toolNames: string[]): Promise<AgentConfig> {
  const repo = new SettingsRepo(new Db(env.DB));
  const settings = await repo.all();

  const get = (key: string): string | undefined => {
    const v = settings[key];
    return v !== undefined && v.trim() !== "" ? v : undefined;
  };

  // Niche pack activo (BOT_NICHE). Aporta el playbook del giro y un tono por
  // defecto; ambos se pueden sobreescribir desde el panel.
  const niche = getNiche(env);

  const systemPromptOverride = get(SETTING_KEYS.systemPromptOverride);
  const businessContext = await contextoDelNegocio(env, settings);
  const botName = get(SETTING_KEYS.botName) ?? env.BOT_NAME;
  // Tono elegido en el panel gana; si no hay, el tono por defecto del nicho.
  const tone = get(SETTING_KEYS.tone) ?? (niche.defaultTone || undefined);
  // De usted si no se eligió: es lo que enseña la tarjeta del panel por
  // defecto, y lo que pidió el dueño (2-nov-2026).
  const formaDeTrato = normalizarTrato(get(SETTING_KEYS.formaDeTrato)) ?? "usted";
  const escalationKeywords = parseCsvList(get(SETTING_KEYS.escalationKeywords));
  // Reglas extra del dueño (pestaña Config): se suman al prompt generado.
  const instrucciones = get(SETTING_KEYS.customInstructions);

  // Flywheel lessons (JSON array). Only injected into the GENERATED prompt —
  // a manual override replaces the whole prompt, lessons included.
  let lessons: string[] = [];
  try {
    const parsed = JSON.parse(get(SETTING_KEYS.learnedLessons) ?? "[]");
    if (Array.isArray(parsed)) lessons = parsed.filter((l) => typeof l === "string");
  } catch { /* malformed setting — ignore */ }

  // Dashboard tool toggles: the prompt only advertises the enabled tools, so
  // the model never tries to call something that was turned off.
  const disabledTools = parseCsvList(get(SETTING_KEYS.disabledTools));
  const enabledToolNames = toolNames.filter((n) => !disabledTools.includes(n));

  /*
   * Los enlaces van en su propia sección del prompt (<enlaces_autorizados>),
   * que es donde el modelo los respeta, pero salen del MISMO texto del panel:
   * las líneas «- Nombre: https://…» de la Información del negocio. Antes
   * salían de member/config.local.ts, una segunda fuente.
   */
  const authorizedLinks = enlacesDelContexto(businessContext);

  const systemPrompt =
    systemPromptOverride ??
    systemPromptFromEnv(env, enabledToolNames, businessContext, niche.playbook || undefined, {
      tone,
      formaDeTrato,
      extraEscalationKeywords: escalationKeywords,
      botName,
      lessons,
      authorizedLinks,
      instrucciones,
    });

  const bufferSecondsRaw = get(SETTING_KEYS.bufferSeconds);
  const bufferMs =
    bufferSecondsRaw !== undefined
      ? Math.max(1000, parseIntOr(bufferSecondsRaw, 1) * 1000)
      : getBufferMs(env);

  const maxChunks = clamp(parseIntOr(get(SETTING_KEYS.maxChunks), 3), 1, 5);
  const interChunkDelayMs = clamp(parseIntOr(get(SETTING_KEYS.interChunkDelayMs), 1000), 0, 5000);
  const modelOverride = normalizeModelOverride(get(SETTING_KEYS.modelOverride));
  const botPaused = get(SETTING_KEYS.botPaused) === "1";

  const tempRaw = get(SETTING_KEYS.temperature);
  let temperature: number | undefined;
  if (tempRaw !== undefined) {
    const t = Number.parseFloat(tempRaw);
    if (!Number.isNaN(t)) temperature = clamp(t, 0, 1);
  }

  /*
   * Horario laboral. Si lo del panel no se entiende, se usa el default
   * (L-V 9-18) en vez de "todo el día": una errata no puede convertirse en
   * permiso para escribir de madrugada.
   */
  const businessHoursRaw = get(SETTING_KEYS.businessHours);
  const businessHours = parseBusinessHours(businessHoursRaw) ?? DEFAULT_BUSINESS_HOURS;
  if (businessHoursRaw && !parseBusinessHours(businessHoursRaw)) {
    console.warn(
      `[settings] horario laboral no entendido: "${businessHoursRaw}". ` +
        `Se usa el de por defecto (L-V 09:00-18:00).`,
    );
  }

  const budgetRaw = get(SETTING_KEYS.monthlyBudget);
  let monthlyBudgetUsd: number | undefined;
  if (budgetRaw !== undefined) {
    const b = Number.parseFloat(budgetRaw);
    if (!Number.isNaN(b) && b > 0) monthlyBudgetUsd = b;
  }

  return {
    systemPrompt,
    bufferMs,
    maxChunks,
    interChunkDelayMs,
    modelOverride,
    botPaused,
    enabledToolNames,
    temperature,
    monthlyBudgetUsd,
    timezone: env.BOT_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    businessHours,
    llm: llmOverridesFrom(settings),
    escalationKeywords,
    frasesProhibidas: frasesProhibidasDe(get(SETTING_KEYS.frasesProhibidas)),
    botName,
    tone,
    formaDeTrato,
  };
}
