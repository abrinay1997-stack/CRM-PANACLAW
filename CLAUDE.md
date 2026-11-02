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
- **El panel es el cerebro: una sola fuente** (decisión del dueño, 25-oct-2026). Todo lo
  que el bot sabe del negocio vive en el panel: la Información del negocio (Configuración,
  con sus enlaces en la sección `ENLACES`) y la pestaña Conocimiento (D1 `kb_docs`). El bot
  NO lee `member/config.local.ts`, `member/kb/` ni `scripts/kb-fixtures.json`: solo siembran
  el panel una vez en una instalación nueva. Vectorize es un espejo del panel que el cron
  pone al día cada hora. Nunca escribas un precio, un plazo ni una URL en el repo del bot:
  se cambia en el panel (y en el sitio, que es otro producto). `pnpm kb:sync` baja el sitio
  a `member/kb/` solo para auditar el panel. Ver `docs/cerebro-web.md`.

## Mapa rápido

- `src/index.ts` — webhooks de canales (Telegram, WhatsApp, Meta…).
- `src/agent.ts` — el Durable Object que piensa y responde (buffer + tools).
- `src/llm/provider.ts` — el cerebro (Anthropic / OpenAI / xAI / **Meta** Muse Spark, con llave
  propia). Meta va por su puerta compatible con Anthropic (`api.meta.ai/v1`) con
  `META_API_KEY` (o `MODEL_API_KEY`), que **no** es el token de Messenger/Instagram. Se elige
  en Config → Modelo de IA. Nunca pongas `ANTHROPIC_BASE_URL` en el Worker. Igual que Baby Caleb.
- `src/replies/cifras.ts` — ninguna cifra de dinero sale sin fuente. Una frase que insiste en
  una cifra sin respaldo se quita (como Juan en D'Casa); el resto de la respuesta sale.
- `src/replies/revisor.ts` — lo que la respuesta NO puede decir (un pago dado por recibido,
  un cupo «reservado», una fecha prometida, huecos de plantilla y las «Frases que el bot nunca
  dice» del panel), comprobado antes de enviar: el modelo la rehace una vez y, si lo que
  bloquea sigue, sale una respuesta segura y pasa a una persona. Traído de Baby Caleb.
- `src/admin/` — el panel (`/admin`): Resumen, Conversaciones, Conexiones, Config, KB, Costos.
- `src/media/adjuntos.ts` — las fotos, notas de voz y documentos del cliente, guardados en R2
  (bucket `CATALOG`, prefijo `conversaciones/`) al llegar. El mensaje lleva `[ADJUNTO: <id>]`
  y el panel lo convierte en la foto, el reproductor o el documento
  (`src/admin/views/mensajes.ts`). Solo foto, audio y PDF se abren dentro del panel; lo demás
  se descarga. Se borran con la conversación.
- `src/meta/conversiones.ts` — le avisa a Meta (Conversions API de mensajería) quién de los que
  llegaron por un anuncio de WhatsApp se volvió lead (captureLead → `LeadSubmitted`) y quién
  compró (el dueño marca «Vendido» con el monto → `Purchase`). Guarda el `ctwa_clid` del primer
  mensaje; una vez por clic y evento, dentro de los 7 días del clic, sin frenar la respuesta;
  nunca manda nombre ni teléfono. Estado y botón de prueba en Configuración → Publicidad en Meta.
- `src/noCliente.ts` — quién escribe sin venir a comprar (un préstamo, un empleo, un toque sin
  querer, dos saludos sin nada más), detectado sin IA. Con la marca no hay lead, ni aviso a
  Meta, ni seguimiento, y el bot cierra con amabilidad; el panel la enseña y el dueño la quita
  o la pone a mano. A Meta solo va el lead de quien escribió algo propio además del mensaje
  automático del anuncio. `src/meta/porAnuncio.ts` es la tabla por anuncio de Configuración →
  Publicidad en Meta (llegaron, contestaron, no clientes, leads, ventas).
- `src/tools/` — searchKb, handoffHuman, pauseBot, captureLead, scheduleAppointment, catalogQuery.
- `src/niches/` — el "niche pack" genérico (Starter). Personaliza tono/columnas del panel.
- `src/hours.ts` — el horario laboral del negocio: acota el seguimiento (de día sí, de noche
  no) y le dice al bot si hay alguien del equipo ahora mismo.
- `src/followup/run.ts` — el seguimiento a quien deja de contestar: 5 h, 3 días y 7 días,
  solo en horario y nunca a quien dijo que no (la misma regla en los tres CRMs).
- `src/kb/docs.ts` — la base de conocimiento del panel y su espejo en Vectorize (semilla,
  reindex, sincronización por cron). `src/tools/searchKb.ts` solo devuelve texto del panel.
- `scripts/sync-kb-from-site.ts` — baja el sitio a `member/kb/` para auditar el panel
  (`pnpm kb:sync`). El bot no lo lee.
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
