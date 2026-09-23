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

**El plan que salió de aquí:** [`plan-baby-caleb-whatsapp-qr.md`](./plan-baby-caleb-whatsapp-qr.md)
— hoy es un **borrador**: se reescribe cuando el canal esté construido en
PanaClaw, para que el port sea copiar algo que existe y no diseñarlo de nuevo.
Tres CRMs con tres variantes del mismo canal es el resultado que se quiere
evitar: cada arreglo futuro habría que pensarlo tres veces.

---

## Estado

| | |
|---|---|
| Fase actual | producción — **sostiene el socket con el panel cerrado**, medido el 17-sep |
| Rama | `claude/admiring-bohr-v99blu` |
| Última actualización | 2026-09-17 |

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

**3. ~~HTTPS + token, no service binding.~~ CORREGIDO — service binding entre los
dos Workers.**

> El razonamiento original era: *"un service binding no cruza cuentas de
> Cloudflare, y Baby Caleb está en otra cuenta"*. **Estaba mal.** El bot y su
> puente viven SIEMPRE en la misma cuenta — la del cliente. Baby Caleb tendrá
> los suyos en la suya, igual que PanaClaw aquí. El cruce entre cuentas que
> motivó la decisión no ocurre nunca.
>
> Y no era solo un detalle de elegancia: **Cloudflare RECHAZA que un Worker
> llame a otro Worker de la misma cuenta por su URL pública**, con el error
> `1042`. Ver la entrada en "Qué salió mal".

El contenedor sí sigue hablando por HTTPS + token, porque no tiene bindings.

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

### El circuito panel → puente quedó cerrado (15-sep-2026, 21:41 UTC)

**Qué se probó.** Con los dos Workers desplegados desde el merge de #25, la
pestaña Conexiones del panel muestra la tarjeta *WhatsApp (por código QR)* en
**ESPERANDO EL CÓDIGO**, con el QR rendido y las instrucciones de vincular.

**Qué demuestra exactamente.** Tres saltos que antes no se habían visto juntos:

1. El panel (Worker del bot) llama al puente **por service binding** — el 1042
   desapareció, que era el síntoma que nos tuvo tres rondas.
2. El puente arranca el contenedor y le habla por `getTcpPort`.
3. El contenedor levanta Baileys, genera el QR y lo devuelve por la misma
   cadena hasta el navegador.

**Qué NO demuestra todavía.** El camino de vuelta: que entre un mensaje
(`contenedor → /puente/entrante → binding CRM → /webhooks/whatsapp-qr`) y que
la respuesta salga (`agente → PUENTE_WA → /api/enviar → contenedor → WhatsApp`).
Ese segundo lado del binding nunca ha corrido con tráfico real. Se anota aquí
para no confundir "el QR aparece" con "el canal funciona" — son dos hechos
distintos y solo el primero está verificado.

**Detalle de la tarjeta que vale la pena conservar.** La Cloud API oficial sigue
marcada CONECTADO al lado. Es el diseño: el QR es alterno y si WhatsApp banea el
número vinculado, el bot no se queda mudo.

**¿Le pasará a Baby Caleb?** El circuito es el mismo, pero los dos bindings hay
que declararlos en los dos `wrangler.toml` de allá y desplegar los dos Workers
**a la vez**. Con uno solo desplegado, ese lado apunta a un binding que el otro
todavía no declara. Es el paso que más fácil se hace a medias.

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

### El bot contestaba encima del dueño (23-sep-2026, visto en Baby Caleb, portado aquí)

**Síntoma.** Con el canal ya estable, la dueña contestaba a una clienta desde el
teléfono del negocio y el bot seguía respondiendo en la misma conversación. Los
dos le escribían a la vez. En Telegram y en la API oficial eso no pasaba: ahí la
respuesta humana pausa el bot.

**Causa.** El contenedor tiraba **todo** mensaje propio:

    if (msg.key?.fromMe) continue;

Un mensaje que sale del número del negocio es `fromMe` lo mande el bot o lo
escriba una persona, así que el CRM nunca se enteraba de que alguien había
tomado la conversación.

**Arreglo.**

- El bot genera el id de cada mensaje ANTES de enviarlo y lo anota
  (`puente-wa/contenedor/propios.mjs`). Tiene que ser antes: Baileys emite el
  eco de lo enviado en el mismo tick en que termina `sendMessage`, y el id que
  devuelve llegaría tarde a su propio eco.
- Un `fromMe` que no está anotado, con contenido de verdad (no una reacción ni
  un borrado), de un chat uno a uno y reciente → lo escribió una persona. Va por
  una ruta APARTE: `/puente/propio` → `/webhooks/whatsapp-qr/propio`. Aparte a
  propósito: un bot sin este cambio contesta 404 en vez de tratar el texto de
  la dueña como si fuera de la clienta.
- El CRM anota el mensaje como `owner` y pausa la conversación
  (`src/takeover.ts`). Segunda red: si el texto es igual a lo que el bot acaba
  de decir, es un eco que se coló tras un reinicio y no pausa.
- WhatsApp mezcla identificadores LID y número para el mismo chat: el puente
  manda los dos (y los que resuelve su mapa), y el CRM usa el que ya tenga
  conversación.
- El agente revisa la pausa en tres momentos: al llegar el mensaje, al vencer
  la espera del buffer y **justo antes de enviar** — el modelo tarda segundos,
  y en esos segundos la dueña pudo haber contestado.

**Orden de despliegue.** Primero el bot (merge a `main`), después el puente
(sale solo con el mismo merge porque cambia `puente-wa/`, y se reinicia solo).
Al revés tampoco rompe nada: un bot viejo contesta 404 a la ruta nueva.

**Mismo código en los dos repos.** El contenedor, el puente y `src/takeover.ts`
son iguales aquí y en Baby Caleb (salvo el nombre del navegador y los textos).

### El canal se quedó mudo toda la noche (16-sep-2026)

**El síntoma, contado por el dueño.** Le escribió al número vinculado el día
después de la prueba y **el bot no contestó**. Abrió el panel de administración,
esperó, **la conexión se restableció sola**, volvió a escribir y esa vez sí
contestó.

Ese "se restableció sola al abrir el panel" es el dato entero. No es una
casualidad: es la firma del fallo.

**La evidencia, en la base en vivo** (`panaclaw-wa-auth`, consultada el 16-sep a
las 16:05 UTC):

| cuándo (UTC) | qué se escribió | qué significa |
|---|---|---|
| 15-sep 22:21 | 1080 filas (812 pre-keys, app-state…) | el emparejamiento, completo |
| 15-sep 22:34 | 2 filas | la prueba de esa noche |
| **16-sep 05:48** | **152 filas `lid-mapping` de golpe** | **una reconexión en frío, resincronizando entera** |
| 16-sep 07:48 / 10:18 | 1–2 filas sueltas | restos |
| 16-sep 15:58 / 16:00 | 7 + 2 filas | el dueño abriendo el panel y escribiendo |

Una sesión viva las 24 horas no produce una resincronización de 152 filas a las
5:48 ni diez horas de silencio después. El emparejamiento sí estaba perfecto
(`firstUnuploadedPreKeyId == nextPreKeyId == 813`): el fallo del §5 no volvió,
este es otro.

**Por qué.** Tres defectos encadenados, y el tercero es el que explica el
"se arregló al abrir el panel".

**1. El latido medía lo que no importaba.** `alarm()` solo miraba
`ctx.container.running`. Un contenedor prendido con el socket de Baileys muerto
salía **sano**. Lo irónico es que el código ya lo sabía: el comentario de
`#marcarSano()` dice textualmente *"Responder es la ÚNICA señal fiable de salud"*
— y el latido usaba `running` de todos modos.

**2. La reconexión tenía un callejón sin salida.** En `servidor.mjs`:

```js
setTimeout(() => {
  reconexionProgramada = false;
  conectar().catch((e) => {
    estado.ultimoError = `reconectar: ${e.message}`;
    console.error("Fallo al reconectar:", e.message);
  });
}, espera);
```

Si `conectar()` rechazaba —y puede: lo primero que hace es `kvGet("creds")`, que
es un viaje HTTPS al puente— el error se anotaba y **nadie volvía a intentarlo
nunca**. El arranque (`arrancar()`) sí reintenta en un `for(;;)`; la reconexión
no. Esa asimetría era el agujero.

**3. `alarm()` podía morirse para siempre.** `setAlarm` era la **última** línea
de `alarm()`, y `#encender()` → `container.start()` no estaba protegido.
`start()` lanza en dos casos que este repo ya documentó: "ya está corriendo"
(una carrera contra un fetch del panel basta) y *"There is no container instance
that can be provided to this Durable Object"* — citado en `comun.ts` desde el
piloto. Cuando `alarm()` lanza, Cloudflare la reintenta unas pocas veces y
**se rinde**. Y `alarm()` era lo único que programaba la alarma siguiente: sin
alarma no hay latido, sin latido el Durable Object se queda quieto y el
contenedor se apaga. El único camino de vuelta era una petición entrante —
`#asegurarEncendido()` — o sea, **que alguien abriera el panel**.

**Cómo se arregló.** Cuatro cosas, en los dos lados:

| pieza | qué hace | qué pasa si se quita |
|---|---|---|
| `setAlarm` **al principio** de `alarm()`, y el trabajo dentro de un `try` | el latido no puede morirse: la alarma siguiente ya está puesta antes de que nada pueda fallar | vuelve el fallo entero |
| `veredictoDeSalud()` + `GET /estado` en cada latido | el latido pregunta "¿WhatsApp está conectado?", no "¿el proceso está prendido?" | un contenedor prendido y mudo vuelve a salir sano |
| `programarReconexion()` que se reprograma en su propio `catch` | la cadena de reconexión no se puede cortar | una promesa rechazada deja el canal mudo para siempre |
| el **vigilante** dentro del contenedor (cada 30 s) | red de última instancia: rescata sockets zombis y reconexiones que nadie programó | los casos que el camino normal no llega a ejecutar quedan sin cubrir |

Y dos escalones de rescate, de barato a caro: primero `POST /reconectar` al
contenedor; si a los **cinco latidos** (~5 min) sigue mudo, se destruye el
contenedor y el latido siguiente lo levanta de cero. Destruirlo sale gratis en
credenciales —viven en D1, está medido— y cuesta una resincronización.

`esperando-qr` y `desvinculada` quedan fuera de todo esto a propósito: no son
fallos, son estados que esperan a una persona. Reiniciar ahí genera un código
nuevo y le tumba al dueño el que está mirando en la pantalla.

**Lo que se aprendió, que vale más que el arreglo.** Un latido que no se reporta
a sí mismo no es un latido: es una suposición. Durante horas el panel mostró el
canal como si todo estuviera bien, porque nadie le había preguntado nunca al
latido si seguía vivo. Ahora la tarjeta dice **"Conexión revisada hace 40
segundos"**, y si eso se vence, lo dice en rojo. El dueño no tiene que
descubrir el silencio escribiéndole al bot.

> Es el mismo error del §5 con otra ropa: **medimos una señal que sale verde
> tanto si el sistema funciona como si no.** Allá fue "¿reconecta sin QR?" en
> vez de "¿terminó de instalarse?". Aquí fue "¿el proceso está prendido?" en vez
> de "¿WhatsApp está conectado?". Vale la pena preguntarse, cada vez: **¿qué se
> vería exactamente igual de verde si esto estuviera roto?**

**¿Le pasará a Baby Caleb?** **Le pasaría idéntico** — no depende del repo ni de
la cuenta, es el mismo código. Por eso el port lleva el arreglo desde el primer
día y allá el canal nunca llega a tener la versión rota.

> **Corrección del 17-sep-2026.** Ese arreglo era necesario pero **no era la
> causa**. El latido reescrito medía por fin lo correcto — y seguía sin llegar,
> porque el Durable Object que lo ejecutaba se desalojaba entre latido y latido.
> Ver la entrada siguiente. Y la última frase de arriba salió al revés: el canal
> llegó a Baby Caleb con la versión arreglada del latido **y** con el fallo de
> fondo intacto, porque el fallo de fondo estaba en el mismo piloto y todavía no
> lo habíamos visto.

### El canal estaba apagado, no degradado: el DO se desalojaba (17-sep-2026)

**Qué pasó.** El fallo se manifestó en **Baby Caleb**, ya en producción, y en
palabras de su dueño: «cuando la página del CRM no está abierta, el WhatsApp no
responde». Escuchando ese Worker tres minutos con el panel cerrado: **cero
eventos**. En dos horas y media, **89 arranques de contenedor contra 76
latidos**.

Aquí no había estallado todavía, y no porque este lado fuera distinto —es el
mismo código— sino porque **nadie había dejado este canal solo una noche
entera** después del arreglo del 16-sep.

**Por qué.** En `@cloudflare/containers`, dentro de su manejador de alarma:

```
// do not remove this, container DOs ALWAYS need an alarm right now.
```

Su `alarm()` duerme **dentro** del propio manejador y al despertar la vuelve a
armar con `setAlarm(Date.now())`: siempre hay una alarma en vuelo, y eso es lo
que mantiene al DO residente en memoria. **El contenedor vive mientras vive su
Durable Object.** El nuestro hacía su trabajo y retornaba: entre latido y latido
no quedaba ninguna alarma en vuelo, el DO se desalojaba y el contenedor se iba
con él. El retroceso exponencial del latido alargaba esos huecos hasta quince
minutos. Abrir el panel mandaba una petición, la petición despertaba el DO, y el
mérito se lo llevaba la página.

**Cómo se arregló** (los dos repos, mismo cambio):

1. `PuenteWa` **extiende `Container`** en vez de usar `ctx.container` crudo. La
   nota que justificaba lo contrario —«evita una dependencia más en la ruta
   crítica»— es la que tuvo el canal caído: eso no es azúcar, es el ciclo de
   vida. La vigilancia va por `schedule()` y **no** sobrescribiendo `alarm()`.
2. Un **Cron Trigger cada minuto**: un supervisor **fuera** del DO. Uno que vive
   dentro de la cosa que vigila no puede levantarla cuando se cae del todo.
3. **Fuera el retroceso.** Treinta segundos fijos. Esperar cada vez más tras
   cada fallo es correcto para algo que se reintenta y es lo contrario de lo que
   necesita un socket que debe estar siempre abierto.

**La prueba, aquí y con el panel cerrado.** La última escritura de la sesión en
`panaclaw-wa-auth` pasó de las 01:19 a las **02:30:07** sin que nadie tocara
nada: el contenedor volvió, leyó las credenciales de D1 y **reabrió el socket
sin código QR**. Con `hay_creds: 1` y `sin_subir == siguiente == 813`. Eso es la
definición operativa de 24/7 para este canal.

**Detalle de operación.** El cron tarda unos **once minutos** en empezar a
llegar después del despliegue que lo estrena. Dos escuchas en silencio seguidas
de una tercera con todo funcionando no son un fallo intermitente, son eso.

> Tercera vez que la misma trampa cobra peaje, y ya merece nombre: **¿qué se
> vería exactamente igual de verde si esto estuviera roto?** Aquí la respuesta
> era cruel: el panel. El panel se veía bien porque **abrirlo era lo que
> arreglaba el canal**. Ningún diagnóstico hecho mirando el panel podía
> encontrar este fallo — hubo que escuchar el Worker con el panel cerrado.

### Trampas del mismo arreglo (17-sep-2026)

Tres, y ninguna llegó a producción rota:

- **`schedule()` agrega, no reemplaza.** Tres sitios programaban la vigilancia,
  así que había tres cadenas, y las cadenas se multiplican: un cron que vigilara
  por su cuenta haría nacer una cadena nueva por minuto y a la hora habría
  sesenta arrancando contenedores en paralelo. Programar tiene **un solo
  dueño**: `vigilar()`.
- **`onStart()` se dispara en cada `startAndWaitForPorts()`**, aunque el
  contenedor ya estuviera arriba, así que la cuenta de arranques subía 120 por
  hora sola. No es cosmético: esa cuenta **contra** la de latidos es la señal que
  encontró el fallo de arriba. Ahora todo arranque pedido pasa por `#arrancar()`,
  que mira `running` antes y distingue un arranque de una comprobación.
- **Faltaba `pnpm install` en el workflow del puente.** Desde que el bundle
  importa `@cloudflare/containers`, sin instalar dependencias el deploy muere al
  empaquetar con un error que no dice que falte instalar.

### `npx wrangler@4` rompió el despliegue sin que tocáramos nada (17-sep-2026)

```
VALIDATE_INPUT
observability cannot define both observability and configuration.observability
```

**Por qué.** `npx wrangler@4` trae siempre la última publicada. La **4.133.0**
salió el 16-sep a las 20:23 UTC —49 minutos después del último despliegue verde,
que corrió con la 4.132.0— y empezó a mandar
`containers.configuration.observability.logs` además del campo `observability`
que la aplicación ya tenía. La API rechaza las dos formas juntas.

**Cómo se arregló.** La versión va clavada: `WRANGLER: "4.132.0"`. Un despliegue
que depende de «lo último que hayan publicado» no es reproducible — el mismo
commit pasa hoy y falla mañana sin que nadie toque nada.

### `vitest` verde no es `tsc` verde (15-sep-2026, 21:20 UTC)

**Qué pasó.** El PR #25 —el que arregla el error 1042 con service bindings— llegó
al CI en rojo. El código de producción estaba bien; lo que no compilaba eran los
tests que yo mismo acababa de escribir:

```
test/channels/whatsappQr.test.ts(84,45): error TS2493:
  Tuple type '[]' of length '0' has no element at index '0'.
```

**Por qué.** `vi.fn(async () => …)` no declara parámetros, así que para TypeScript
`mock.calls` es una tupla vacía y `calls[0][0]` no existe. Yo leí las tres nuevas
aserciones como "el espía recibió esta petición" y el tipo decía otra cosa.

El error de proceso es más importante que el de tipos: después de editar los tests
corrí **solo `pnpm test`**. Vitest no hace typecheck — transpila y ejecuta —, así
que los 13 tests pasaron y me dieron una señal verde que no cubría lo que había
roto. Mi última corrida limpia de `tsc` era de *antes* de tocar el archivo.

**Cómo se arregló.** Declarando el parámetro: `vi.fn(async (_req: Request) => …)`.
De paso desaparecen los `as unknown as Request` — el tipo sale del espía y no de
una aserción, que es lo que uno quiere de un test. Luego `pnpm typecheck` **y**
`pnpm test`: 700 tests, 80 archivos, todo verde.

**Lo que hay que llevarse.** El CI corre `pnpm typecheck` antes que `pnpm test`,
y por eso cazó esto antes del merge — el riel hizo su trabajo. Pero la regla
propia es: *si toqué un archivo `.ts`, aunque sea un test, corro los dos comandos*.
Tocar solo tests no es una excepción; es justo donde da más confianza falsa,
porque el verde de vitest se siente como el verde completo.

**¿Le pasará a Baby Caleb?** **Sí, igual**, y ahí importa más: su `deploy.yml`
despliega en cada merge a `main`. Aquí el rojo se quedó en un PR; allá un test mal
tipado que pase el filtro equivocado se mete al riel de producción. El plan de
port tiene que decir explícitamente `pnpm typecheck && pnpm test` como un solo
paso, no como dos opcionales.

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

### Error 1042: un Worker no puede llamar a otro de la misma cuenta por URL

**Qué pasó.** Con todo desplegado y el token correcto, la tarjeta del panel
decía "No se pudo hablar con el servicio de WhatsApp". Al instrumentar el error
apareció el código: `404`. Y al adjuntar el cuerpo de la respuesta, el veredicto:

```
el puente respondió 404 · error code: 1042
```

**Por qué.** El `1042` es de Cloudflare, no del código: **un Worker no puede
hacer una subpetición a otro Worker de la misma cuenta por su URL pública.** La
petición ni siquiera llega a la puerta del otro Worker.

Eso explica el detalle que no cuadraba: **si hubiera sido el token, habría sido
401, no 404.** Nunca pasó por la autenticación porque nunca llegó.

**Cómo se arregló.** Service binding en los DOS sentidos: el bot llama al puente
con el binding `PUENTE_WA`, y el puente reenvía los entrantes al bot con el
binding `CRM`. Más rápido, sin salto por la red pública y sin token en ese tramo
—aunque el token se conserva como segunda barrera.

**Un segundo sitio que todavía no había explotado:** el puente reenviaba los
mensajes entrantes al bot por su URL pública. Habría fallado con el mismo 1042
en cuanto llegara el primer mensaje, y el síntoma —un canal que recibe pero no
contesta— habría sido mucho más confuso de diagnosticar.

**Cuánto costó llegar aquí.** Tres rondas de instrumentación: primero "no se
pudo", luego el código de estado, luego el cuerpo. Solo el tercero nombró la
causa. **Un código de estado no distingue "la ruta no existe" de "la petición no
llegó"** — el cuerpo sí, y por eso el error del panel lo incluye ahora.

**¿Le pasará a Baby Caleb?** **Sí, idéntico**, y por eso la corrección va en las
decisiones de diseño y no solo aquí. No depende de la cuenta ni del repo:
depende de que los dos Workers vivan juntos, que es siempre.

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

## 23-sep-2026 · Las notas de voz y las fotos llegaban vacías (portado de Baby Caleb)

El contenedor solo reenviaba `conversation` y `extendedTextMessage.text`: de una
nota de voz no mandaba nada, y de una foto ni la leyenda. No era Baileys: la
Cloud API y Telegram dejan el archivo en una URL que se descarga después;
Baileys no, se descarga en el contenedor en el momento o se pierde.

Ahora el contenedor lo descarga (`downloadMediaMessage`, tope 12 MB) y lo manda
en base64 con la leyenda. El CRM lo guarda en D1 (`media_temporal`, dos días) y
lo ve como el de cualquier canal: una URL firmada
(`/webhooks/whatsapp-qr/media/:id`). La transcripción lee D1 directo. Las
reacciones y los mensajes de protocolo ya no llegan al agente vacíos.

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
