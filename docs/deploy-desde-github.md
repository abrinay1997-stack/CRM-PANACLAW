# Configurar y desplegar sin terminal (GitHub Actions)

Todo lo que normalmente se hace con `pnpm wrangler secret put ...` y
`pnpm run deploy` se puede hacer desde el navegador, con el workflow
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

La idea: guardas cada llave **una vez** en GitHub (un formulario web), y el
workflow la carga en tu Worker de Cloudflare y publica el bot.

---

## Paso 1 — El token de Cloudflare (una sola vez)

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) → tu perfil →
   **API Tokens** → **Create Token**.
2. Usa la plantilla **"Edit Cloudflare Workers"**.
3. Antes de crearlo, agrégale dos permisos más: **D1 → Edit** y
   **Vectorize → Edit**. El deploy aplica el esquema de la base y crea el
   índice de la base de conocimiento; sin esos permisos falla ahí.
4. Copia el token (solo se muestra una vez).

Guárdalo en este repo:

> **Settings → Secrets and variables → Actions → New repository secret**
> - Name: `CLOUDFLARE_API_TOKEN`
> - Secret: *(pega el token)*

Si tu cuenta de Cloudflare tiene varias cuentas asociadas, agrega también
`CLOUDFLARE_ACCOUNT_ID` (lo ves en la barra lateral del panel de Workers).

---

## Paso 2 — Las llaves del bot

Mismo formulario, un secret por cada cosa que quieras encender. Solo agrega los
que uses: **lo que no exista se ignora**, y el workflow nunca borra un secret
que ya esté funcionando en el Worker.

| Para qué | Secrets |
|---|---|
| El cerebro (obligatorio) | `ANTHROPIC_API_KEY` |
| Entrar al panel | `DASHBOARD_PASSWORD` |
| Reindexar la base de conocimiento | `KB_REINDEX_TOKEN` |
| **Aviso de handoff por correo** | `RESEND_API_KEY`, `OWNER_EMAIL`, y `RESEND_FROM` si ya verificaste tu dominio |
| **Aviso de handoff por Telegram** | `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_CHAT_ID` |
| WhatsApp oficial (Meta) | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| Instagram / Messenger | `META_PAGE_ACCESS_TOKEN`, `META_VERIFY_TOKEN`, `META_APP_SECRET` |
| WhatsApp por Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WA_FROM`, `TWILIO_HANDOFF_CONTENT_SID`, `OWNER_WA_NUMBER` |
| Agenda | `CALCOM_API_KEY` |

La lista completa que el workflow reconoce está en el propio
`deploy.yml` (variable `PERMITIDOS`) y sale de `src/env.ts`.

> Los valores **nunca** aparecen en los logs: el workflow imprime solo los
> nombres de lo que cargó.

---

## Paso 3 — Correr el workflow

Pestaña **Actions** → **Configurar y desplegar** → **Run workflow**.

Tienes tres opciones:

- **secrets-y-deploy** (default) — carga las llaves y publica. Es la normal.
- **solo-secrets** — solo actualiza las llaves. Útil si Cloudflare ya despliega
  tu bot por su cuenta (Workers Builds).
- **solo-deploy** — solo publica el código.

El workflow solo corre cuando tú lo lanzas: no se dispara solo en cada push,
para no estorbar si despliegas desde el panel de Cloudflare. Si quieres el
deploy automático al mergear a `main`, el propio `deploy.yml` dice qué dos
líneas agregar.

Antes de publicar siempre corre `pnpm typecheck` y `pnpm test`: si algo está
roto, no se despliega nada.

---

## Paso 4 — Verificar

Abre `https://<tu-worker>.workers.dev/admin` y mira **Salud del bot** en el
Resumen. Si configuraste los avisos, debería decir en verde:

> ✓ handoff avisa por Telegram + Email

Si sigue en rojo con **HANDOFF SIN AVISO**, es que ningún canal quedó completo:
el correo necesita `RESEND_API_KEY` **y** `OWNER_EMAIL`; Telegram necesita
`TELEGRAM_BOT_TOKEN` **y** `OWNER_TELEGRAM_CHAT_ID`. Con uno de los dos pares
basta.

---

## Notas

- **El aviso por Telegram ya no necesita secret.** Panel → Conexiones →
  Telegram → **Vincular mi Telegram**: un enlace de un solo uso, y listo. Ver
  `docs/consola-del-dueno.md`. Si prefieres el secret de siempre, tu chat id te
  lo da el bot con **`/miid`** y va en `OWNER_TELEGRAM_CHAT_ID`.
- **El correo de Resend sin dominio verificado** sale de `onboarding@resend.dev`
  y **solo entrega al correo con el que abriste tu cuenta de Resend**. Si
  `OWNER_EMAIL` es otro, Resend lo rechaza — se ve en los logs del Worker como
  `[notifyOwner] resend 403`. Cuando verifiques tu dominio, agrega
  `RESEND_FROM` (ej. `avisos@tunegocio.com`).
- **Para cambiar una llave**, edita el secret en GitHub y vuelve a correr el
  workflow. No hace falta borrar nada en Cloudflare.
