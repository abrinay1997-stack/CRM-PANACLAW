# PanaClaw — instrucciones para Claude Code

Este repo es **PanaClaw**, un chatbot de soporte con IA open source: un Worker de
Cloudflare (Hono + Vercel AI SDK + D1 + Vectorize + R2) con panel de administración
en `/admin`. Quien lo clona probablemente **no sabe programar** — tú corres todo por él.

## Instalación (si no existe `.bot-state.json`)

Sigue el skill **`/configurar-mi-chatbot`** (en `skill/`; si no está registrado, abre
el archivo directo). Son 4 fases y el orden no se negocia:

1. **TU PLATAFORMA** — provisiona Cloudflare (D1/Vectorize/R2), guarda la API key del
   cerebro + `DASHBOARD_PASSWORD`, y despliega. Al terminar, su panel vive en
   `https://<worker>.workers.dev/admin`.
2. **TU CHATBOT** — negocio, tareas, idioma y base de conocimiento.
3. **TUS CONEXIONES** — canales uno por uno (Telegram, WhatsApp, Meta…) desde `/admin`.
4. **PRUEBA FINAL** — mensaje real + resumen sin badges rojos.

Antes de la Fase 1: verifica que existan **Node ≥18** y **pnpm** (`corepack enable pnpm`
si falta), y explícale al usuario cómo funciona y cuánto cuesta — vive en SU cuenta de
Cloudflare (~gratis, ~$5/mes con tráfico) y el cerebro es su propia llave de IA (~$1–2/mes).

## Reglas

- **Habla en español sencillo (LATAM)**, una pregunta a la vez.
- **Nunca pegues tokens/keys en el chat** — siempre `wrangler secret put`.
- **No toques `member/`** más allá de lo que indican los skills (ahí viven los datos del
  negocio del usuario; se respetan en cada actualización).
- Package manager: **pnpm** — `pnpm dev`, `pnpm run deploy`, `pnpm typecheck`, `pnpm test`,
  `pnpm db:apply:remote`. Corre `pnpm test` antes de cualquier deploy si tocaste `src/`.
- **El panel también se usa desde el teléfono.** Antes de tocar `src/admin/views/`, lee
  `docs/design-system.md` — el §7 (Móvil y accesibilidad) es contrato: 16 px en campos,
  44 px táctiles, piso de 12 px en texto, nada de `min-width` en píxeles ni `100vh`.
  `pnpm snapshot` rinde las 15 pestañas a `.snapshots/` para comparar antes y después.
- **La web es el cerebro.** En este bot (el oficial de PanaClaw) todo lo que se afirma sale
  de `panaclaw.com`: `pnpm kb:sync` baja `/kb.json` a `member/kb/`, y de ahí a Vectorize con
  `pnpm kb:reindex` + `POST /kb/reindex`. Nunca escribas un precio, un plazo ni una URL a
  mano en el repo del bot — se cambia en el sitio y se sincroniza. Ver `docs/cerebro-web.md`.

## Mapa rápido

- `src/index.ts` — webhooks de canales (Telegram, WhatsApp, Meta…).
- `src/agent.ts` — el Durable Object que piensa y responde (buffer + tools).
- `src/llm/provider.ts` — el cerebro (Anthropic / OpenAI / xAI / **Meta** Muse Spark, con llave
  propia). Meta va por su puerta compatible con Anthropic (`api.meta.ai/v1`) con
  `META_API_KEY` (o `MODEL_API_KEY`), que **no** es el token de Messenger/Instagram. Se elige
  en Config → Modelo de IA. Nunca pongas `ANTHROPIC_BASE_URL` en el Worker. Igual que Baby Caleb.
- `src/replies/cifras.ts` — ninguna cifra de dinero sale sin fuente. Una frase que insiste en
  una cifra sin respaldo se quita (como Juan en D'Casa); el resto de la respuesta sale.
- `src/admin/` — el panel (`/admin`): Resumen, Conversaciones, Conexiones, Config, KB, Costos.
- `src/tools/` — searchKb, handoffHuman, pauseBot, captureLead, scheduleAppointment, catalogQuery.
- `src/niches/` — el "niche pack" genérico (Starter). Personaliza tono/columnas del panel.
- `src/hours.ts` — el horario laboral del negocio: acota el seguimiento (de día sí, de noche
  no) y le dice al bot si hay alguien del equipo ahora mismo.
- `src/followup/run.ts` — el seguimiento a quien deja de contestar: 5 h, 3 días y 7 días,
  solo en horario y nunca a quien dijo que no (la misma regla en los tres CRMs).
- `scripts/sync-kb-from-site.ts` — baja la base de conocimiento del sitio (`pnpm kb:sync`).
- `src/takeover.ts` — cuando una persona contesta (panel, teléfono del WhatsApp por QR
  o Telegram) el bot se calla en esa conversación. Un solo sitio para las tres puertas;
  el plazo sale de Config.
- `src/owner/` — la **consola del dueño por Telegram**: avisos con botones que se pueden
  responder, comandos (`/pendientes`, `/bot`, `/responder`…) y un asistente interno. El
  vínculo es un enlace del panel, sin terminal. El asistente sabe que habla con el
  jefe, entiende notas de voz y fotos, y recuerda la conversación
  (`src/owner/memoria.ts`, tabla `owner_chat`). Ver `docs/consola-del-dueno.md`.
- `puente-wa/` — el canal de WhatsApp por QR. `puente-wa.yml` lo despliega solo cuando
  un merge cambia `puente-wa/` y reinicia el contenedor al terminar (uno sano no toma la
  imagen nueva). Las notas de voz y las fotos las descarga el contenedor y el CRM
  las guarda unas horas en D1 (`src/media/almacen.ts`). Lee
  `docs/bitacora-whatsapp-qr.md` antes de diagnosticar.
- `skill/` — asistentes para el usuario.
- `.github/workflows/deploy.yml` — carga los secrets y despliega desde la web, sin
  terminal. Ver `docs/deploy-desde-github.md`.

## Skills disponibles

- `/configurar-mi-chatbot` — instalación de cero (las 4 fases).
- `/modo-agencia` — un bot por cliente en TU Cloudflare: alta, padrón y límites.
- `/reporte` — informe mensual de valor para el cliente.
- `/exportar` — exporta leads y conversaciones (CSV/JSON).
- `/actualizar-mi-bot` — trae la última versión conservando tu config.
- `/contribuir` — abre issues o manda PRs al repo.

## Estado del proyecto

Todo viene desbloqueado: no hay tiers, licencias ni features de pago. El repo trae un solo
giro (`generico`), que sirve para cualquier negocio; los giros verticales con panel a la
medida están en el roadmap del README.

Derivado de [Forja](https://github.com/santmun/forja) (MIT, © Horizontes IA) — el aviso de
copyright original se conserva en `LICENSE`, como exige la licencia.
