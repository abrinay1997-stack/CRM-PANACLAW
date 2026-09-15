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

**El plan que salió de aquí:** [`plan-baby-caleb-whatsapp-qr.md`](./plan-baby-caleb-whatsapp-qr.md).

---

## Estado

| | |
|---|---|
| Fase actual | 0 — prueba **desplegada y viva**; falta escanear el QR y medir 24 h |
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
| 1 | ¿La cuenta tiene Workers Paid con Containers habilitado? | Los contenedores no existen en el plan gratis. Precondición de todo. | ✅ **sí** — el contenedor desplegó sin el 403 del plan gratis |
| 2 | ¿Cuánto factura el Durable Object del contenedor en 24 h? | Es el único costo que no se puede estimar leyendo documentación. Si no hibernan entre latidos, cambia la cuenta. | ⬜ sin medir |
| 3 | ¿Reconecta solo tras matar el contenedor, sin pedir QR nuevo? | Si no, el canal es inservible: el dueño tendría que re-escanear cada vez que Cloudflare mueva el contenedor. | ✅ **SÍ** — matado a las 19:35; a las 19:36:07 ya escribía `lid-mapping`, que solo existe con el socket autenticado. Sin QR. |
| 4 | ¿La imagen construye en un runner de GitHub Actions? | Si no, no hay deploy desde la web y el cliente queda atado a una terminal. | ✅ **sí** — build + empuje + deploy en 60 s (run #3, 18:09:44→18:10:44 UTC) |
| 5 | ¿El token tiene los permisos correctos? | Incluidos Images/Containers, que el deploy del bot no ejercitaba. | ✅ **sí, completo** — la imagen se empujó al registro de Cloudflare sin error de permisos |

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

## La prueba de humo

Vive en [`humo/wa-qr/`](../humo/wa-qr/) y se despliega sola desde Actions con el
workflow **"Prueba de humo · WhatsApp por QR"**. Es descartable: el README de esa
carpeta dice cómo borrarla entera.

Decisiones que se tomaron al escribirla, y por qué:

- **Worker aparte (`panaclaw-wa-humo`), no el del CRM.** Si la imagen no
  construye, el que no se despliega es el de la prueba. Es la decisión de diseño
  #2 puesta a prueba desde el primer día.
- **Sin `@cloudflare/containers`.** La API cruda de `ctx.container` alcanza, y así
  el repo de producción no gana una dependencia por algo que se va a borrar.
- **`humo/` fuera del `include` del tsconfig.** Verificado: el `typecheck` del CI
  no lo mira, así que esta carpeta no puede poner rojo al bot. Tiene su propio
  `tsconfig.json` para chequearse aparte.
- **D1 propia (`panaclaw-wa-humo`), no la del bot.** La sesión de WhatsApp no se
  mezcla con los datos del negocio.
- **Un solo contenedor (`max_instances = 1`).** Dos sockets sobre el mismo número
  se tumban entre sí.
- **Latido de 60 s por alarma del DO.** Mantiene vivo al contenedor y lo
  relevanta si murió. Son 1.440 disparos al día — el número contra el que se
  compara la factura del Durable Object.

Validado antes de subir: `tsc` limpio sobre el Worker de la prueba, `node --check`
sobre el servidor del contenedor, YAML y TOML parseados, y el repo de producción
intacto (`typecheck`, `css:check`, `icons:check` sin cambios).

Lo que **no** se pudo validar aquí: que Baileys levante y que la imagen construya.
Eso necesita desplegar — es justamente lo que la prueba va a medir.

---

## Qué salió bien

### La prueba que decidía todo: reconecta sin QR (15-sep-2026, 19:36 UTC)

Se mató el contenedor a mano desde el botón de la página. Un minuto después, la
secuencia en D1:

```
19:35      contenedor destruido
19:36:04   pre-keys escritas
19:36:06   creds actualizada
19:36:07   lid-mapping-… escrito
```

Los `lid-mapping` **solo se escriben con el socket abierto y autenticado** — son
dato de runtime, imposible de generar sin conexión. El contenedor nuevo leyó
`creds` de D1, se autenticó contra WhatsApp y siguió, **sin emitir un solo QR**.

Antes ya se había visto lo mismo al reemplazar la imagen: `credencialesVenianDeD1:
true` y 543 pre-keys subidas, que tampoco se suben sin una sesión abierta.

**Conclusión: la decisión de diseño #4 —credenciales en D1, nunca en el disco del
contenedor— funciona.** Es lo que hace viable el canal: Cloudflare puede mover,
reiniciar o reemplazar el contenedor cuando quiera y el dueño no se entera.

### Hallazgo operativo: un contenedor sano NO toma una imagen nueva

Desplegar una imagen no reemplaza al contenedor que está corriendo: el latido lo
ve `running` y lo deja en paz. Durante un rato se estuvo diagnosticando un
contenedor que llevaba media hora con código viejo, y los arreglos "no
aparecían".

Para producción esto **es a favor** —un deploy del puente no corta WhatsApp— pero
hay que saberlo: para que tome una imagen nueva hay que matarlo. Por eso el botón
de matar quedó siempre visible y no solo cuando está conectado.

### Deuda anotada: las pre-keys se acumulan

D1 pasó de 20 KB a 561 KB con **2.473 pre-keys**. Cada ciclo de reconexión sube
un lote y ninguno se limpia. En la prueba no estorba, pero en producción hay que
podarlas o la tabla crece sin techo.

### La prueba de humo desplegó con contenedor (15-sep-2026, 18:10 UTC)

Run #3, sobre la rama, en 1 m 30 s. El paso de despliegue —build de Docker,
empuje al registro de Cloudflare y publicación— tomó **60 segundos** y salió
verde. Verificado además contra Cloudflare: el Worker `panaclaw-wa-humo` existe,
`modified_on = 2026-09-15T18:10:44Z`.

Eso cierra de una sola vez tres preguntas abiertas:

- **La cuenta tiene Workers Paid con Containers.** No apareció el 403 del plan
  gratis, que es como se manifiesta la falta.
- **La imagen construye y se empuja desde un runner de GitHub.** Sin terminal.
- **El token está completo**, Images/Containers incluidos.

Un detalle de diseño que conviene tener presente: el contenedor **arranca
perezoso**, en la primera petición al Worker (`#asegurarEncendido`). Recién
desplegado, la tabla `wa_humo_auth` está vacía y no hay nada corriendo. Se
enciende cuando alguien abre `/qr`.

### Aparte: desde este entorno no se puede verificar por HTTP

El proxy de salida del entorno donde trabajo bloquea `workers.dev` — devuelve
`CONNECT tunnel failed, response 403`. Se comprobó contra el Worker de
producción, que está vivo, y da el mismo error: es el proxy, no el Worker.

Consecuencia práctica: **la verificación de estas pruebas se hace por el MCP de
Cloudflare** (listar Workers, consultar D1) o desde el navegador del dueño, no
con `curl` desde aquí. Aplica igual para Baby Caleb.

### El riel de deploy quedó verde (15-sep-2026, 17:29 UTC)

Run #3 sobre `claude/clever-edison-z1tka6`, opción `solo-deploy`, en 3 m 11 s.
Todos los pasos en verde; "Cargar los secrets" salió *skipped*, que es lo correcto
para `solo-deploy`.

**Verificado contra Cloudflare, no solo contra el ✓ de GitHub:** el Worker
`panaclaw-oficial` quedó con `modified_on = 2026-09-15T17:29:03Z`, que coincide con
el paso de despliegue. Se republicó de verdad.

Lo que esto cierra: el token sirve para Workers Scripts, D1 y Vectorize. Lo que
**no** cierra: los permisos de **Cloudflare Images / Containers** siguen sin
ejercitarse — ningún paso de este deploy construye ni empuja una imagen. Eso solo
se sabrá en la prueba de humo del contenedor.

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

### El 401 del puente: una cabecera HTTP no entrega un token con tildes

**Qué pasó.** El contenedor arrancaba pero nunca emitía QR. Se trababa en su
primera llamada al puente con `kvGet(creds) → 401`, aunque una persona entraba
sin problema con el MISMO token por `?t=` en la URL.

**Cómo se encontró.** Releer el código no sirvió: las dos mitades estaban bien.
Se instrumentaron los dos lados para publicar el largo del token y una huella de
cuatro caracteres. El resultado fue concluyente:

| | largo | huella |
|---|---|---|
| Token del contenedor | 95 | `1im7` |
| Token del Worker | 95 | `1im7` |
| **Lo recibido por cabecera** | **95** | **`1mxu`** |

Los dos lados tenían el mismo secreto —`ctx.container.start({ env })` sí entrega
bien las variables— pero lo que llegaba tenía **mismo largo y distinto
contenido**. El token se mutaba en tránsito, carácter por carácter.

**Por qué.** Node escribe el valor de una cabecera en latin-1, un byte por code
unit, y el runtime de Cloudflare lo lee como UTF-8. Un solo carácter fuera de
ASCII en el token viaja como un byte suelto que es UTF-8 inválido, y se convierte
en el carácter de reemplazo. Uno por uno: el largo no cambia. Por eso el 401 no
delataba nada. Por `?t=` en la URL no ocurre, porque ahí el valor va en
porcentajes.

**Cómo se arregló.** El contenedor manda el token en base64
(`x-humo-token-b64`), que es ASCII puro pase lo que pase, y el Worker lo decodifica
con `TextDecoder`.

**La trampa al diagnosticar, que costó una vuelta entera.** La primera hipótesis
fue exactamente ésta y se descartó por una prueba mala: se probó Node contra
Node, donde la codificación es simétrica y se cancela, y dio verde. La asimetría
solo aparece al cruzar hacia el runtime de Cloudflare. **Una prueba entre dos
procesos iguales no reproduce un problema de interoperabilidad**; hay que simular
el lado contrario (escribir latin-1, leer UTF-8) o probarlo en el destino real.

**¿Le pasará a Baby Caleb?** **Sí, idéntico** — es Node hablándole a un Worker,
no depende del repo. Y hay una lección que va más allá del arreglo: **los
secretos que cruzan hacia un contenedor deberían restringirse a ASCII**
(hexadecimal o base64url). Un token con una ñ o una tilde funciona en todas las
pruebas manuales por navegador y falla solo en la máquina, que es el peor sitio
donde puede fallar.

### La imagen no construía — `libsignal` viene de git, y `slim` no trae git

**Qué pasó.** Con `HUMO_TOKEN` ya guardado, el workflow llegó a construir la
imagen y murió ahí:

```
npm error enoent An unknown git error occurred
ERROR: process "/bin/sh -c npm install --omit=dev" did not complete successfully: exit code: 254
```

**Por qué.** Baileys no baja todo de npm: depende de **`libsignal` desde un
repositorio de GitHub**. Confirmado en el lockfile de BukoFlow:

```
node_modules/libsignal -> git+ssh://git@github.com/whiskeysockets/libsignal-node.git
```

`node:22-bookworm-slim` no trae `git`, así que npm no podía clonarlo. Y hay una
segunda mitad: npm resuelve ese repositorio por **ssh**, y un build de Docker no
tiene llave SSH.

**Cómo se arregló.** Dockerfile en dos etapas. La primera instala `git` y
reescribe ssh→https con `git config --global url.…insteadOf`; la segunda solo
copia `node_modules`, así `git` no viaja en la imagen final — menos superficie y
menos disco, que en Containers se factura por GB-segundo las 24 horas.

**Validado de verdad, no supuesto.** El daemon de Docker no corre en el entorno
donde trabajo, pero sí Node 22 y git, así que se corrió el `npm install` exacto
que fallaba, con el reescrito aplicado: **107 paquetes, `libsignal` presente,
sin errores.**

**El mensaje engañoso, otra vez.** `enoent An unknown git error occurred` no
nombra a git como faltante ni dice qué dependencia lo necesitaba. Es el segundo
error de esta bitácora que apunta al lugar equivocado — después de
"No se pudo crear el índice" que en realidad era la versión de Node.

**¿Le pasará a Baby Caleb?** **Sí, idéntico.** No depende del repo ni de la
cuenta: es Baileys más una imagen base sin git. El Dockerfile ya corregido se
porta tal cual.

### Baileys 7.0.0-rc.9 tiene un aviso de seguridad

**Qué pasó.** Al correr el `npm install` de validación, npm avisó:

```
npm warn deprecated @whiskeysockets/baileys@7.0.0-rc.9: This version is affected
by a zero-day vulnerability that allows spoofing of messages, please update to
(6.7.22^ or 7.0.0-rc12^)!   GHSA-qvv5-jq5g-4cgg
```

**Por qué.** La prueba se había fijado en `7.0.0-rc.9` para igualar a BukoFlow,
que es la versión de la que se copió el patrón.

**Cómo se arregló.** Subida a `^7.0.0-rc.12`; instala `7.0.0-rc14` sin avisos.

**Ojo fuera de este repo:** **BukoFlow corre hoy `^7.0.0-rc.9`**, o sea la
versión afectada, en producción sobre Railway. No es asunto de esta bitácora,
pero quedó anotado porque salió de aquí.

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

   **Comparación de los dos `deploy.yml` (verificada línea por línea, 2026-09-15).**

   | | PanaClaw | Baby Caleb |
   |---|---|---|
   | Pruebas como candado | ✅ `typecheck` + `test` | ✅ `typecheck` + `test` |
   | Esquema de D1 | ✅ dentro de `ci-deploy.mjs` | ✅ paso propio (`db-apply.mjs`) |
   | `concurrency` | ✅ global (`deploy-worker`) | ✅ por rama |
   | Node 22 | ✗ estaba en 20 (arreglado hoy) | ✅ ya lo tenía |
   | **Reindexar la KB tras desplegar** | **✗ no existe** | ✅ con `--fail-with-body` |

   **La única brecha real es la última, y es seria.** Según el propio `CLAUDE.md` de
   PanaClaw, lo que `searchKb` consulta es el índice de Vectorize, y ese índice solo
   cambia con `POST /kb/reindex`. Hoy un deploy de PanaClaw termina en verde
   **dejando al bot con el conocimiento anterior** — que es justo lo que el
   comentario de Baby Caleb llama "la peor combinación, porque todo parece bien".

   Esto **no bloquea** el canal de QR (el QR es transporte, no contenido), así que no
   se arregla en esta rama para no mezclar. Queda anotado como deuda aparte.
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
