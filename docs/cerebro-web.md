# El panel es el cerebro del bot

Todo lo que el bot sabe del negocio —precios, plazos, qué incluye cada plan,
horario, teléfono, enlaces— vive en **un solo lugar: el panel** (`/admin`). Si el
panel no lo dice, el bot no lo sabe, y en vez de improvisar lo admite y pasa con
una persona.

Hasta el 25-oct-2026 había dos fuentes: el panel y el repositorio (los enlaces de
`member/config.local.ts` y 85 fichas del sitio en `scripts/kb-fixtures.json`). Se
contradijeron: el panel daba el WhatsApp de EE. UU. que el repo ya había cambiado
por el de Panamá, decía que no había reuniones presenciales y que eBot se entrega
en 48 horas, cuando el sitio dice 3 a 5 días. El dueño pidió una sola fuente, la
de la aplicación, y así quedó.

## Dónde está cada cosa

| Qué | Dónde se cambia | Dónde vive |
|---|---|---|
| Información del negocio (horario, catálogo, precios, contacto, cómo vender) | Configuración → «Información del negocio» | D1 `settings.business_context` |
| Enlaces que el bot puede mandar | La sección `ENLACES` de ese mismo texto, una línea por enlace: `- Planes y precios: https://panaclaw.com/planes/` | ídem |
| Todo lo demás (preguntas frecuentes, objeciones, detalle de cada plan) | Pestaña Conocimiento | D1 `kb_docs` |

El buscador (Vectorize) **no es una fuente**: es un espejo de la pestaña
Conocimiento. `searchKb` lo usa para saber qué documento contesta y toma el
texto de D1, así que un cambio se lee bien desde el siguiente mensaje. El cron
de cada hora vuelve a indexar lo que cambió (`sincronizarIndiceSiCambio`, en
`src/kb/docs.ts`), por cualquier camino: el editor del panel, la consola de
Telegram o un cambio directo en la base. Un borrador con `[COMPLETA AQUÍ]` nunca
se le entrega al bot.

## Lo que queda en el repositorio, y para qué

- `member/config.local.ts` y `scripts/kb-fixtures.json` son **semillas**: en una
  instalación nueva, la primera vez que el bot arranca con el panel vacío, se
  copian AL panel (una sola vez) y desde ahí manda el panel. En el bot de PanaClaw
  el panel ya estaba lleno, así que no se copió nada y las fichas se borraron del
  buscador.
- `pnpm kb:sync` sigue bajando `/kb.json` del sitio a `member/kb/sitio-web.json`,
  como **referencia para auditar** el panel contra lo publicado. El bot no lo lee.

Hay pruebas que fallan si una segunda fuente vuelve a entrar
(`test/fuente-unica.test.ts`).

## Cuando cambia un precio

1. Se cambia en el sitio (repo `PanaClaw`): es lo que ve el cliente en la web.
2. Se cambia en el panel: Configuración y/o la pestaña Conocimiento. El bot lo
   dice desde el siguiente mensaje.

Si solo se cambia el sitio, el bot sigue diciendo lo viejo. Si solo se cambia el
panel, la web y el bot no coinciden. Son dos pasos, a propósito: la web y el bot
son dos productos, pero el bot tiene una sola fuente.

## Qué NO se escribe a mano en el repo del bot

- **Precios, plazos, condiciones y URLs.** Van en el panel.
- **Totales.** El bot no suma ni negocia: para una cifra cerrada existe el
  cotizador (`https://panaclaw.com/cotizador/`), y para lo formal, una persona.

## La cifra que no pueda copiar, no sale

Lo de arriba dice de dónde salen los precios. Esto es lo que pasa cuando el bot
escribe uno que no salió de ahí.

Antes de mandar la respuesta, `src/replies/cifras.ts` saca cada importe que el
bot escribió y busca de dónde lo copió: una línea del contexto del negocio o un
trozo que devolvió `searchKb` en ese mismo turno. No basta con que la cifra
exista — tiene que existir **junto a lo que se está hablando**. Un cliente
preguntó si las páginas se hacen con IA y el bot, sin ese dato en la KB,
improvisó y ofreció el chatbot "por $70 pago único"; el precio publicado es
$499. El $70 era real: es el piso de Web Blindada, el plan de seguridad
mensual. Por eso la lista blanca de importes del sitio no habría servido de
nada, y por eso aquí se valida el número **con su producto**.

Si algo no cuadra, el bot recibe la frase señalada y una orden de buscar el
precio antes de volver a escribir. Un cliente que repite un precio que no
cobramos cuesta más que una respuesta que se quedó corta.

Esto no sustituye al panel como fuente: sustituye al prompt como *ruego*. El
prompt ya pedía no inventar cifras en tres sitios distintos, y se cumplía casi
siempre. El "casi" lo pagaba el cliente.

Desde el 25-oct-2026 la guardia ya no tira la respuesta entera: si el modelo
insiste en una cifra sin fuente, se quita solo esa frase y el resto sale (como
Juan en D'Casa). Y si no queda nada que mandar, la respuesta de respaldo abre
un ticket y le avisa al dueño, porque promete que una persona contesta.

## Horario: responder siempre, escribir primero solo de día

Dos cosas distintas, y conviene no confundirlas:

- **Responder**: a cualquier hora. Quien escribe a las 2 de la mañana recibe
  respuesta a las 2 de la mañana.
- **Escribir primero** (el seguimiento a un lead que se quedó callado): solo
  dentro del horario de atención, en la zona horaria del negocio.

El horario se configura en **/admin → Config → "Horario de atención"** con el
formato `L-V 9:00-18:00` (días `L M X J V S D`). Si se deja vacío o no se
entiende, se usa lunes a viernes de 9 a 18 — el default es conservador a
propósito: ante la duda, no se le escribe a nadie de madrugada.

Ese mismo horario le dice al bot si en este momento hay alguien del equipo. Con
él sabe que fuera de horario no debe prometer que "alguien te contesta ya", sino
decir cuándo le responden.

El cron corre cada hora (`wrangler.toml`), y los ticks que caen fuera de horario
salen sin hacer nada.
