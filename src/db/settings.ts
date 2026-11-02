import { Db } from "./client";

// Canonical setting keys. Every value is stored as TEXT; the loader parses.
// Empty/absent => default (see settings-loader.ts).
export const SETTING_KEYS = {
  systemPromptOverride: "system_prompt_override",
  businessContext: "business_context",
  // "1" cuando la Información del negocio ya se sembró en el panel desde
  // member/config.local.ts (una sola vez, ver contextoDelNegocio). Desde ahí el
  // panel es la única fuente: si el dueño la vacía, se queda vacía.
  contextoSembrado: "contexto_sembrado",
  // Frases que el bot no puede decir nunca, una por línea y con su motivo
  // después de " | " (panel → Configuración). Las vigila el revisor
  // (src/replies/revisor.ts): si la respuesta las trae, no sale.
  frasesProhibidas: "frases_prohibidas",
  // Lo mismo para la base de conocimiento: "1" cuando kb_docs ya se sembró (o
  // ya tenía documentos) y lo del repo dejó de contar para siempre.
  kbSembrada: "kb_sembrada",
  // Huella de kb_docs (id, fecha y largo de cada documento) la última vez que
  // el índice de búsqueda quedó igual al panel. Si cambia, el cron reindexa.
  kbFirmaIndice: "kb_firma_indice",
  botName: "bot_name",
  tone: "tone",
  formaDeTrato: "forma_de_trato", // usted | tu — cómo le habla el bot al cliente (Configuración)
  bufferSeconds: "buffer_seconds",
  maxChunks: "max_chunks",
  interChunkDelayMs: "inter_chunk_delay_ms",
  escalationKeywords: "escalation_keywords",
  modelOverride: "model_override", // auto | haiku | sonnet
  botPaused: "bot_paused", // 0 | 1
  disabledTools: "disabled_tools", // comma-separated tool names turned off from the dashboard
  temperature: "temperature", // LLM sampling temperature 0-1; empty = provider default
  monthlyBudget: "monthly_budget", // USD cap for monthly AI spend; empty = no cap
  learnedLessons: "learned_lessons", // JSON array of rules distilled from owner takeovers
  twilioHandoffContentSid: "twilio_handoff_content_sid", // HSM del aviso de handoff (fallback del secret)
  autonomyLevel: "autonomy_level", // flywheel: manual (default) | copilot (auto-aplica lo seguro de noche)
  // Horario laboral del negocio, en su zona horaria. Formato "L-V 9:00-18:00";
  // vacío = lunes a viernes de 9 a 18. Decide DOS cosas: cuándo puede el bot
  // mandar seguimientos (fuera de horario, nunca) y qué le dice al cliente
  // sobre cuándo le responde una persona. Responder, responde siempre.
  businessHours: "business_hours",
  // BYO-LLM (dashboard "Modelo de IA"): the owner plugs their own provider,
  // API key and/or concrete model. Empty = the instance's env defaults.
  llmProvider: "llm_provider", // "" (auto) | anthropic | openai
  llmApiKey: "llm_api_key", // owner's API key; empty = use the env key
  llmModel: "llm_model", // concrete model id; empty = auto tiers (fast⇄smart)
  // El último fallo REAL del modelo en una conversación (JSON, ver
  // src/llm/ultimoFallo.ts): el error que devolvió el proveedor. Config lo
  // muestra, porque el error solo vivía en los logs de Cloudflare y "Algo falló
  // de mi lado" no dice nada. Se pisa en cada fallo: es el último, no un historial.
  ultimoFalloLlm: "ultimo_fallo_llm",
  // Reglas extra del dueño que se SUMAN al prompt generado (pestaña Config).
  // No confundir con system_prompt_override, que lo REEMPLAZA entero — ver
  // src/settings-loader.ts para la historia de por qué son dos llaves.
  customInstructions: "custom_instructions",
  // Cuántos minutos se calla el bot en una conversación después de que una
  // persona del equipo contesta (panel, teléfono del WhatsApp por QR, Telegram).
  takeoverMinutes: "takeover_minutes",
  // El chat de Telegram del dueño, vinculado desde el panel con un código. Hace
  // lo mismo que el secret OWNER_TELEGRAM_CHAT_ID, sin abrir una terminal.
  ownerTelegramChatId: "owner_telegram_chat_id",
  // Conversiones para Meta Ads (src/meta/conversiones.ts). La cuenta de
  // WhatsApp Business sale sola del webhook; el conjunto de datos (dataset) se
  // pide a Meta la primera vez, o lo pone el dueño en Configuración.
  metaWabaId: "meta_waba_id",
  metaDatasetId: "meta_dataset_id",
  // El último aviso a Meta (JSON): el panel lo enseña.
  metaUltimoEnvio: "meta_ultimo_envio",
  // "<código>:<vence en ms>" — el código de un solo uso para vincularlo.
  ownerLinkCode: "owner_link_code",
  // "cliente" = el dueño está probando el bot como si fuera un cliente: sus
  // mensajes van al agente y no a la consola. Vacío = consola del dueño.
  ownerTelegramMode: "owner_tg_modo",
  // Huella del secreto con el que se registró el webhook de Telegram. Si
  // coincide con la del token actual, la consola ya está protegida y no se
  // vuelve a llamar a setWebhook (ver protegerConsolaUnaVez).
  ownerWebhookFirmado: "owner_tg_webhook_firmado",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

interface SettingRow {
  key: string;
  value: string;
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.first<SettingRow>(
      "SELECT value FROM settings WHERE key = ?",
      [key],
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
    );
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.all<SettingRow>(
      "SELECT key, value FROM settings",
    );
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[row.key] = row.value;
    }
    return out;
  }
}
