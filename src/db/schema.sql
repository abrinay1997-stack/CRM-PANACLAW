-- Conversations: one row per (channel, channel_user_id) customer
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  display_name TEXT,
  started_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  paused_until INTEGER,
  open_ticket_id TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_unique ON conversations(channel, channel_user_id);
CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  model_used TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  audio_seconds REAL,
  image_count INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  name TEXT,
  contact TEXT,
  channel_user_id TEXT,
  intent TEXT NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'new',
  exported_to TEXT,
  external_id TEXT,
  -- JSON con campos propios del nicho (reservacion con fecha/hora/personas, o
  -- comprador con presupuesto/zona/operacion). El dashboard del nicho lee de aqui.
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  category TEXT,
  summary TEXT NOT NULL,
  transcript TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS admin_emails (
  email TEXT PRIMARY KEY,
  role TEXT DEFAULT 'owner',
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_expires ON magic_links(expires_at);

-- Settings: key/value overlay edited from the dashboard. Empty/absent => default.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AI-generated quality analysis: one row per conversation, written by the
-- insights analyzer (Haiku) once the conversation goes idle. Re-analyzed if
-- the customer comes back (analyzed_at < last_message_at).
-- sentiment: positive | neutral | frustrated | angry
-- resolution: resolved | unresolved | escalated | abandoned
-- bot_score: 1-5 quality of the bot's replies · topics: JSON array (es)
-- summary: 1-2 sentences (es) · missed_kb: question the KB couldn't answer
-- sale_opportunity: 1 = open sale left on the table
CREATE TABLE IF NOT EXISTS conversation_insights (
  conversation_id TEXT PRIMARY KEY,
  analyzed_at INTEGER NOT NULL,
  sentiment TEXT,
  resolution TEXT,
  bot_score INTEGER,
  topics TEXT,
  summary TEXT,
  missed_kb TEXT,
  sale_opportunity INTEGER DEFAULT 0,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_insights_analyzed ON conversation_insights(analyzed_at);

-- Knowledge-base documents editable from the dashboard. Indexed into Vectorize
-- on save (chunked). The repo kb-fixtures.json remains a separate source.
-- NOTE: never put semicolons inside schema comments (the test helper splits on them).
CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Flywheel (F5) - every proposed self-improvement is a reviewable row.
-- kind: kb_entry | leccion. fingerprint dedupes across any status so a
-- dismissed suggestion is never re-proposed.
CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  evidence TEXT,
  status TEXT DEFAULT 'proposed',
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sugg_status ON improvement_suggestions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sugg_fp ON improvement_suggestions(kind, fingerprint);

-- Follow-up bot - one row per conversation that ever received a follow-up.
-- The PRIMARY KEY doubles as the send claim (INSERT OR IGNORE) so a
-- conversation can never get more than one follow-up, ever.
CREATE TABLE IF NOT EXISTS followup_sends (
  conversation_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

-- Per-customer memory extracted by the insights analyzer. Injected into the
-- system context when the same customer writes again.
CREATE TABLE IF NOT EXISTS customer_facts (
  conversation_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  learned_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, fact)
);

-- Links de trackeo por conversación (código destino, con contador de clicks).
-- Un código por conversación y destino, alimenta la segmentación de campañas.
CREATE TABLE IF NOT EXISTS tracked_links (
  code TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  target TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  last_click_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracked_links_conv ON tracked_links(conversation_id);

-- Hits de keywords (QUIERO / RECURSOS) — alimenta la segmentación de campañas
CREATE TABLE IF NOT EXISTS keyword_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyword_hits_kw ON keyword_hits(keyword);

-- Etiquetas por conversación (interés + objeción) para la segmentación de campañas.
-- La tabla se conserva para el módulo de campañas/segmentos.
CREATE TABLE IF NOT EXISTS conv_labels (
  conversation_id TEXT PRIMARY KEY,
  variant TEXT,
  interest TEXT,
  objection TEXT,
  summary TEXT,
  labeled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_labels_interest ON conv_labels(interest);

-- Envíos de campañas (free-form dentro de ventana / plantilla HSM fuera)
-- El UNIQUE es el candado anti-doble-envío por campaña
CREATE TABLE IF NOT EXISTS template_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  template_sid TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE (campaign_key, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_template_sends_time ON template_sends(sent_at);

-- Libro de gasto de IA. UNA fila por llamada al modelo, venga de donde venga:
-- el chat, el analista nocturno, el flywheel, los follow-ups o los botones del
-- panel. Antes el costo se calculaba solo sobre `messages`, así que todo el
-- trabajo que no era un chat aparecía en la factura del proveedor pero NO en el
-- panel. Guardamos tokens (no dinero) para que un ajuste de tarifas corrija
-- también el histórico.
--
-- Sin comentarios al final de línea: el helper de tests aplana cada statement
-- en una sola línea y un `--` se comería el resto.
--   source: chat | insights | flywheel | followup | suggest | test
--   conversation_id: NULL en los trabajos que no salen de un chat
--   input_tokens: entrada TOTAL, incluye lo leído y lo escrito en caché
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_conv ON ai_usage(conversation_id);

-- Backfill del histórico: el id es el del mensaje, así que re-aplicar el
-- esquema no duplica nada (y los turnos nuevos ya entran con ese mismo id).
INSERT OR IGNORE INTO ai_usage (
  id, source, conversation_id, model,
  input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, created_at
)
SELECT id, 'chat', conversation_id, model_used,
       COALESCE(input_tokens, 0), COALESCE(cached_input_tokens, 0), 0,
       COALESCE(output_tokens, 0), created_at
FROM messages
WHERE model_used IS NOT NULL;

-- ── Consola del dueño por Telegram ─────────────────────────────────────────
-- Una acción que espera el SÍ del dueño: el mensaje que el asistente propone
-- mandarle a un cliente, "devolver al bot", "pausar". El botón de Telegram solo
-- carga el id (callback_data tiene tope de 64 bytes), el detalle vive aquí.
-- status: pendiente | hecha | descartada
CREATE TABLE IF NOT EXISTS owner_actions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pendiente',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

-- Cada aviso que se le manda al dueño por Telegram, con la conversación de la
-- que habla. Es lo que permite que el dueño toque "Responder" sobre el aviso y
-- su texto le llegue a ESA clienta, sin tener que copiar ningún identificador.
CREATE TABLE IF NOT EXISTS owner_notices (
  tg_chat_id      TEXT NOT NULL,
  tg_message_id   INTEGER NOT NULL,
  conversation_id TEXT,
  ticket_id       TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tg_chat_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_notices_conv ON owner_notices(conversation_id);

-- La conversación del dueño con su consola: lo que le dijo y lo que se le
-- contestó. Es la memoria del asistente interno, para que "¿y la M?" o "dile
-- que sí" se entiendan por lo que se habló antes, como pasa con las clientas.
-- rol: dueno | consola
CREATE TABLE IF NOT EXISTS owner_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  rol        TEXT NOT NULL,
  contenido  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_chat ON owner_chat(chat_id, created_at);

-- Audios e imágenes que llegan por el WhatsApp por QR. Baileys no deja una URL
-- que se pueda descargar después (como la Cloud API o Telegram), así que el
-- contenedor manda los bytes y se guardan aquí unas horas: lo justo para
-- transcribirlos, que el modelo vea la imagen o reenviársela al dueño. En
-- partes, porque una fila de D1 tiene tope de tamaño.
CREATE TABLE IF NOT EXISTS media_temporal (
  id         TEXT NOT NULL,
  parte      INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  datos      BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, parte)
);
CREATE INDEX IF NOT EXISTS idx_media_temporal_fecha ON media_temporal(created_at);

-- Las fotos del cliente que ya le llegaron a la dueña por Telegram. Con esto
-- cada aviso sobre una conversación lleva la última foto del cliente, sin
-- repetir la misma en el aviso siguiente (src/owner/avisos.ts).
CREATE TABLE IF NOT EXISTS owner_fotos (
  conversation_id TEXT NOT NULL,
  url             TEXT NOT NULL,
  enviada_en      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, url)
);

-- Los seguimientos a clientes que dejaron de contestar: 5 horas, 3 días y 7
-- días, en horario laboral (src/followup/run.ts). `ciclo` es la hora del último
-- mensaje del cliente: si vuelve a escribir, empieza un ciclo nuevo. La llave
-- primaria es el claim — un paso de un ciclo sale una sola vez.
-- Reemplaza a followup_sends (un solo seguimiento de por vida), que se queda
-- por las filas viejas.
CREATE TABLE IF NOT EXISTS seguimientos (
  conversation_id TEXT NOT NULL,
  ciclo           INTEGER NOT NULL,
  paso            INTEGER NOT NULL,
  enviado_en      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, ciclo, paso)
);
CREATE INDEX IF NOT EXISTS idx_seguimientos_fecha ON seguimientos(enviado_en);

-- Las fotos, notas de voz y documentos del cliente, para verlos y escucharlos
-- en el panel (src/media/adjuntos.ts). El archivo vive en R2 (bucket CATALOG,
-- prefijo conversaciones/), y el mensaje lleva la marca [ADJUNTO: <id>]. Se
-- borran con la conversación.
CREATE TABLE IF NOT EXISTS adjuntos (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tipo            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  nombre          TEXT,
  r2_key          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjuntos_conv ON adjuntos(conversation_id, created_at);
