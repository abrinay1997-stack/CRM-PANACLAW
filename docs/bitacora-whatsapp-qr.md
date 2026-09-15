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
| Fase actual | 0 — riel de deploy en arreglo |
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
| 5 | ¿El token tiene los permisos correctos? | El primer deploy murió por la versión de Node, antes de llamar a Cloudflare. Sigue sin verificarse. | ⬜ sin probar |

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

## El token de Cloudflare (`CLOUDFLARE_API_TOKEN`)

Los permisos salen de los comandos que corre `scripts/ci-deploy.mjs`, más los que
pide el contenedor. Partir de la plantilla **"Edit Cloudflare Workers"** y sumarle
lo que falte:

| Permiso | Nivel | De dónde sale la necesidad |
|---|---|---|
| Workers Scripts | Edit | `wrangler deploy` y `wrangler secret bulk` |
| D1 | Edit | `d1 execute --file=src/db/schema.sql --remote` |
| Vectorize | Edit | `vectorize create <índice>` |
| Workers R2 Storage | Edit | binding `CATALOG` (viene en la plantilla) |
| Account Settings | Read | resolver la cuenta (viene en la plantilla) |
| **Cloudflare Images** | **Edit** | **contenedores** — el registro de imágenes se apoya en Images |
| **Containers** | **Edit** | contenedores, si aparece en la lista de tu cuenta |

Los tres primeros no vienen en la plantilla: hay que agregarlos a mano. Los dos
últimos son nuevos, solo para el canal de QR.

### Trampa documentada: el 403 que miente

Desplegar un Worker con contenedores en el **plan gratis** falla con
`ApiError: Forbidden — { error: 'Authentication error' }`. Parece un problema de
permisos del token y **no lo es**: es el plan. Peor: el error llega *después* de
que la imagen de Docker terminó de construirse, así que se paga toda la espera
antes de enterarse.

Si aparece ese 403 con el token recién hecho, lo primero que se revisa es el plan,
no los permisos. (Cloudflare lo tiene reportado como error de mensajería:
`cloudflare/developer-platform#26`.)

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

**Cómo se arregló.** El dueño creó el token el 15-sep-2026 y lo guardó como secret
del repositorio. El chequeo dejó de fallar — aunque el deploy siguió cayéndose, ya
por otra razón (ver la entrada siguiente).

**¿Le pasará a Baby Caleb?** **No.** Su `deploy.yml` lleva 20 corridas exitosas y
dispara solo en cada merge a `main`. Allá el riel ya existe; aquí había que
construirlo. Es la diferencia más grande entre los dos repos y la razón por la que
el orden de las fases no se puede copiar tal cual.

### Primer deploy con token — Node 20 contra wrangler 4.x

**Qué pasó.** Con el token ya creado, el deploy llegó hasta `wrangler vectorize
create` y murió con `Wrangler requires at least Node.js v22.0.0. You are using
v20.20.2`.

**Por qué.** `deploy.yml` y `ci.yml` fijaban `node-version: "20"`, y `package.json`
trae `wrangler` en `"latest"` (hoy 4.95.0), que exige Node ≥22. El piso lo mueve
wrangler solo, sin avisar. El CI nunca lo notó porque no invoca wrangler: corre
typecheck, css, iconos y vitest, y ninguno lo toca.

**Cómo se arregló.** `node-version: "22"` en los dos workflows. Validado en local
sobre Node 22.22.2: wrangler 4.95.0 arranca, typecheck limpio, `css:check` e
`icons:check` al día, y **645 pruebas en 77 archivos, todas verdes**.

**Efecto secundario:** wrangler abortó *antes* de hablar con Cloudflare, así que el
token **sigue sin probarse**. Los permisos del token siguen siendo una incógnita
hasta el próximo deploy.

**Diagnóstico engañoso, para tenerlo presente.** `ci-deploy.mjs` reportó
`✗ No se pudo crear el índice panaclaw_oficial_kb` — que apunta a Vectorize y a los
permisos del token, cuando el problema era la versión de Node. El script trata
cualquier salida distinta de cero de `vectorize create` como fallo del índice. No se
tocó ahora para no mezclar arreglos, pero vale un guardia de versión al inicio del
script: son diez líneas y se ahorra la próxima cacería.

**¿Le pasará a Baby Caleb?** **No — y resulta que allá ya pasó y ya está resuelto.**
Su `deploy.yml` fija Node 22 con este comentario textual:

> *Node 22, no 20: wrangler 4.x exige >= 22 y aborta con "Wrangler requires at
> least Node.js v22.0.0" antes de hablar con Cloudflare.*

BYS también tiene su `ci.yml` en Node 22. **PanaClaw era el único que quedaba
atrás.**

---

## Diferencias que el plan de Baby Caleb tiene que respetar

Lista viva. Cada vez que algo aquí dependa de una particularidad de PanaClaw, se
anota — es lo que evita que el plan portado falle.

1. **El deploy ya funciona allá, y es automático en cada merge a `main`.** No hay
   que crear ningún riel; hay que tener cuidado de no romperlo. Un merge a `main`
   con el contenedor a medias despliega el contenedor a medias.

   **Corrección (2026-09-15).** Yo venía asumiendo que PanaClaw era el repo maduro
   y Baby Caleb el que heredaba. Es al revés en el deploy: el `deploy.yml` de Baby
   Caleb ya trae las pruebas como candado antes de publicar, un paso propio para el
   esquema de D1, el reindexado de la KB con `--fail-with-body`, `concurrency` por
   rama y el arreglo de Node 22 — todo eso PanaClaw no lo tiene. **Para el canal de
   QR, el `deploy.yml` de Baby Caleb es el molde bueno**, y lo que hay que portar
   es de allá para acá, no al revés.
2. **Su token también necesita `Cloudflare Images: Edit`.** Su `deploy.yml` lleva
   20 corridas exitosas con el token actual, que casi seguro NO tiene ese permiso
   — el canal de QR se lo va a exigir. Renovar el token es un paso obligatorio del
   plan portado, y hay que avisarle al dueño **antes** de que el deploy se ponga
   rojo: hoy su deploy dispara solo en cada merge a `main`, así que se enteraría
   por una ✗ en un merge que no tiene nada que ver con WhatsApp.
3. **Su Claude ejecuta por MCP contra su Cloudflare.** El MCP de Cloudflare **no
   tiene herramienta para desplegar Workers ni para construir imágenes** — solo
   D1, KV, R2 y lectura de Workers. Todo el despliegue tiene que pasar por su
   `deploy.yml`. Un plan que le diga "corre `wrangler deploy`" no se puede ejecutar allá.
4. **El dueño de Baby Caleb no usa la terminal** (`CLAUDE.md`). Vincular el número
   tiene que poderse hacer entero desde `/admin` → Conexiones, con el teléfono.
5. **Baby Caleb tiene catálogo y `catalogQuery`; PanaClaw no.** Su `CLAUDE.md`
   tiene reglas duras sobre de dónde sale cada dato (`docs/FUENTES_DE_VERDAD.md`) y
   tests en `test/babycaleb/` que fallan si se rompen. El canal de QR no debe tocar
   nada de eso — es transporte, no contenido — pero conviene correr `pnpm test`
   allá antes y después.
6. **El bot de Baby Caleb habla de usted.** Cualquier texto nuevo que llegue al
   cliente final (avisos de desconexión, mensajes de estado) va en usted.

---

## Riesgo que no se va con ingeniería

Baileys no es oficial: WhatsApp puede banear el número vinculado. Por eso este
canal es **alterno**, y la Cloud API oficial (`/webhooks/whatsapp`) se queda
conectada y funcionando en el mismo bot. Si cae el QR, el bot no se queda mudo.

Conviene que el cliente lo sepa antes de vincular, no después.
