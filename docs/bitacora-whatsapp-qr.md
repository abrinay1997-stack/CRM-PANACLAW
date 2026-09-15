# Bitácora — WhatsApp por QR en Cloudflare

Registro de la implementación del canal **WhatsApp por QR** (Baileys en un
contenedor de Cloudflare), pilotada en PanaClaw.

**Para qué existe este archivo.** PanaClaw es la empresa de la casa: aquí se puede
romper algo. Baby Caleb es de un cliente, con su GitHub, su Cloudflare y su propio
Claude — allá no. Todo lo que se aprenda aquí se anota aquí, y de esta bitácora
sale el plan que ejecutará el Claude de Baby Caleb sin repetir los tropiezos.

**Cómo se llena.** Cada vez que algo se rompa o salga distinto a lo planeado, se
anota en el momento, no al final. Un tropiezo que no se anota es un tropiezo que
el cliente va a repetir.

---

## Estado

| | |
|---|---|
| Fase actual | 0 — sin empezar |
| Rama | `claude/clever-edison-z1tka6` |
| Última actualización | 2026-09-15 |

---

## El mapa de cuentas (verificado 2026-09-15)

Esto condiciona todo lo demás, así que va primero.

| | PanaClaw | BYS Logistics | Baby Caleb |
|---|---|---|---|
| Qué es | Empresa de la casa | Clienta, alojada de favor | Cliente independiente |
| Worker | `panaclaw-oficial` | `bys-logistics` | `juancitoads-bot` |
| Cuenta de Cloudflare | La de la casa | La de la casa (temporal) | **Propia** |
| Dueño del repo | `abrinay1997-stack` | `abrinay1997-stack` | `juanarrietabusiness-pixel` |
| Deploy desde la web | ✗ nunca funcionó | ✗ no existe `deploy.yml` | ✅ automático, 20 corridas |
| Quién ejecuta allá | Nosotros | Nosotros | **Su propio Claude, por MCP** |

BYS ya pagó su Cloudflare; migrarla es **otra tarea**, fuera del alcance de esta.
Mientras siga alojada aquí, no se le pone contenedor: cada contenedor arrastra su
propio Durable Object, y las cuotas incluidas son por cuenta.

---

## Decisiones tomadas antes de escribir código

**1. Contenedor, no Worker puro.** Baileys necesita sostener un WebSocket a
WhatsApp de forma permanente — el protocolo de WhatsApp Web no tiene webhooks, si
nadie sostiene el socket los mensajes no llegan. Un Worker no vive tanto. El
proyecto `whatsapp-cloudflare-workers` lo intentó y su propia documentación admite
que la conexión dura "entre 10 y 50 segundos": sirve para mandar, no para recibir.

**2. El puente va en su propio Worker, no dentro del CRM.** `pnpm deploy:ci` hace
un solo `wrangler deploy`. Si el contenedor se cuelga del Worker del CRM, una
imagen que no construye bloquea el deploy entero: cambias un precio en la KB y no
lo puedes publicar porque WhatsApp está roto. El puente vive aparte y se hablan
por HTTPS con un token.

**3. HTTPS + token, no service binding.** Un service binding no cruza cuentas de
Cloudflare, y Baby Caleb está en otra cuenta. Un solo mecanismo que funcione en
las dos topologías vale más que uno elegante que solo sirva aquí.

**4. Las credenciales van a D1, nunca al disco.** El disco del contenedor es
descartable: si Cloudflare lo mueve o reinicia, se pierde y tocaría re-escanear el
QR. En BukoFlow (Railway) esto se resolvió con un base64 pegado a mano en la
variable `WA_AUTH`; aquí se resuelve con una tabla. El esquema de D1 ya se aplica
solo en cada deploy (`scripts/ci-deploy.mjs`), así que agregar la tabla no le pide
nada manual a nadie.

---

## Preguntas abiertas — se cierran con hechos, no con documentación

| # | Pregunta | Por qué importa | Estado |
|---|---|---|---|
| 1 | ¿La cuenta tiene Workers Paid con Containers habilitado? | Los contenedores no existen en el plan gratis. Precondición de todo. | ⬜ sin verificar |
| 2 | ¿Cuánto factura el Durable Object del contenedor en 24 h? | Es el único costo que no se puede estimar leyendo documentación. Si no hibernan entre latidos, cambia la cuenta. | ⬜ sin medir |
| 3 | ¿Reconecta solo tras matar el contenedor, sin pedir QR nuevo? | Si no, el canal es inservible: el dueño tendría que re-escanear cada vez que Cloudflare mueva el contenedor. | ⬜ sin probar |
| 4 | ¿La imagen construye en un runner de GitHub Actions? | Si no, no hay deploy desde la web y el cliente queda atado a una terminal. | ⬜ sin probar |

---

## Costo estimado (por verificar contra la factura real)

Contenedor `lite` (1/16 vCPU, 256 MiB, 2 GB disco) prendido 24/7, sobre el plan de $5:

| | Primer contenedor de la cuenta | Cada uno adicional |
|---|---|---|
| Memoria | $1.19 | $1.64 |
| Disco | $0.32 | $0.37 |
| CPU (se cobra por uso real) | ~$0 | ~$0 |
| **Total** | **≈ $1.51** | **≈ $2.01** |

Como cada bot termina en su propia cuenta, a cada uno le toca la columna
izquierda: **≈ $1.50–2.00/mes por bot.** Falta sumarle el Durable Object
(pregunta abierta #2).

> Anotar aquí la cifra real cuando llegue la primera factura.

---

## Qué salió bien

_(se llena durante el piloto)_

---

## Qué salió mal

Formato: **qué pasó** → **por qué** → **cómo se arregló** → **¿le pasará a Baby Caleb?**

### Antes de empezar — el deploy de PanaClaw nunca había funcionado

**Qué pasó.** La única corrida de `deploy.yml` (29-ago-2026) murió en la primera
línea: `✗ Falta el secret CLOUDFLARE_API_TOKEN`.

**Por qué.** El secret nunca se creó en el repo. El workflow está bien escrito —
falla temprano y con un mensaje claro, que es lo correcto.

**Cómo se arregló.** _(pendiente — lo tiene que crear el dueño de la cuenta desde
su dashboard)_

**¿Le pasará a Baby Caleb?** **No.** Su `deploy.yml` lleva 20 corridas exitosas y
dispara solo en cada merge a `main`. Allá el riel ya existe; aquí había que
construirlo. Es la diferencia más grande entre los dos repos y la razón por la que
el orden de las fases no se puede copiar tal cual.

---

## Diferencias que el plan de Baby Caleb tiene que respetar

Lista viva. Cada vez que algo aquí dependa de una particularidad de PanaClaw, se
anota — es lo que evita que el plan portado falle.

1. **El deploy ya funciona allá, y es automático en cada merge a `main`.** No hay
   que crear ningún riel; hay que tener cuidado de no romperlo. Un merge a `main`
   con el contenedor a medias despliega el contenedor a medias.
2. **Su Claude ejecuta por MCP contra su Cloudflare.** El MCP de Cloudflare **no
   tiene herramienta para desplegar Workers ni para construir imágenes** — solo
   D1, KV, R2 y lectura de Workers. Todo el despliegue tiene que pasar por su
   `deploy.yml`. Un plan que le diga "corre `wrangler deploy`" no se puede ejecutar allá.
3. **El dueño de Baby Caleb no usa la terminal** (`CLAUDE.md`). Vincular el número
   tiene que poderse hacer entero desde `/admin` → Conexiones, con el teléfono.
4. **Baby Caleb tiene catálogo y `catalogQuery`; PanaClaw no.** Su `CLAUDE.md`
   tiene reglas duras sobre de dónde sale cada dato (`docs/FUENTES_DE_VERDAD.md`) y
   tests en `test/babycaleb/` que fallan si se rompen. El canal de QR no debe tocar
   nada de eso — es transporte, no contenido — pero conviene correr `pnpm test`
   allá antes y después.
5. **El bot de Baby Caleb habla de usted.** Cualquier texto nuevo que llegue al
   cliente final (avisos de desconexión, mensajes de estado) va en usted.

---

## Riesgo que no se va con ingeniería

Baileys no es oficial: WhatsApp puede banear el número vinculado. Por eso este
canal es **alterno**, y la Cloud API oficial (`/webhooks/whatsapp`) se queda
conectada y funcionando en el mismo bot. Si cae el QR, el bot no se queda mudo.

Conviene que el cliente lo sepa antes de vincular, no después.
