# Plan — WhatsApp por QR en Baby Caleb

**Para quién es esto.** Para el Claude que trabaja en el repo
`juanarrietabusiness-pixel/CRM-Baby-Caleb`, contra la cuenta de Cloudflare de ese
cliente. Se escribió después de pilotar el canal entero en PanaClaw, y su único
propósito es que allá no se repita ninguno de los tropiezos que aquí costaron una
tarde. El registro crudo de esos tropiezos está en
[`bitacora-whatsapp-qr.md`](./bitacora-whatsapp-qr.md).

**Qué se quiere lograr.** Que el bot de Baby Caleb pueda atender WhatsApp
vinculando un número con un **código QR** —como WhatsApp Web— además de los
canales que ya tiene. Hoy solo habla WhatsApp por la API oficial de Meta o por
Twilio, que exigen alta comercial. El QR no exige nada: se escanea y funciona.

---

## 1 · Lo que ya está probado — no se vuelve a discutir

Todo esto se midió en PanaClaw con hechos, no con documentación. **No hace falta
re-verificarlo**, solo respetarlo:

| | Veredicto |
|---|---|
| Baileys corre en un contenedor de Cloudflare | ✅ Sí |
| La imagen construye y se empuja desde GitHub Actions, sin terminal | ✅ Sí, en ~60 s |
| **La sesión sobrevive a que el contenedor muera** | ✅ Sí — reconecta desde D1 **sin pedir QR** |
| Un contenedor `lite` 24/7 cuesta | ≈ **$1.50–2.00/mes** sobre el plan de $5 |

La prueba decisiva: se mató el contenedor a mano y un minuto después ya escribía
`lid-mapping` en D1 — filas que solo existen con el socket abierto y autenticado.
Sin QR nuevo.

**Lo que hace que eso funcione es una sola decisión: las credenciales viven en
D1, nunca en el disco del contenedor.** El disco es descartable. Si algo de este
plan se va a desviar, que no sea eso.

---

## 2 · La arquitectura, en una figura

```
  Teléfono del cliente ──escanea UNA vez──┐
                                          ▼
  WhatsApp ◄══ wss 24/7 ══►  CONTENEDOR  (lite: 1/16 vCPU, 256 MiB)
                                 │  Baileys + servidor HTTP :8080
                                 │
                                 │ ① HTTPS + token → credenciales a D1
                                 │ ② POST mensajes entrantes
                                 ▼
                          WORKER PUENTE  «juancitoads-wa»
                                 │        (Worker APARTE, no el del bot)
                                 │
                                 │ POST /webhooks/whatsapp-qr
                                 ▼
                          WORKER DEL BOT  «juancitoads-bot»
                            src/channels/whatsappQr.ts
                            SupportAgent (DO) — sin cambios
```

**El puente va en su propio Worker.** No se le cuelga al bot. Si la imagen del
contenedor no construye, el que no se despliega es el puente — el bot sigue
publicándose. En Baby Caleb esto importa el doble, porque su `deploy.yml` corre
**solo, en cada merge a `main`**: un contenedor roto dentro del bot pondría en
rojo un merge que no tiene nada que ver con WhatsApp.

---

## 3 · Lo que es distinto en Baby Caleb

Esto es lo que NO se puede copiar de PanaClaw tal cual.

**a) El deploy ya funciona, y es automático.** `.github/workflows/deploy.yml`
dispara en cada push a `main` y lleva más de 20 corridas exitosas. En PanaClaw
hubo que construir ese riel; aquí ya existe y **hay que cuidarlo**. Consecuencia
directa: nunca mergear a `main` con el canal a medias.

**b) Su token de Cloudflare necesita un permiso nuevo.** El token actual funciona
para el bot, pero el contenedor exige **`Cloudflare Images: Edit`** (el registro
de imágenes de Cloudflare se apoya en Images), y `Containers: Edit` si aparece en
la lista de la cuenta. **Avisarle al dueño ANTES**, porque si no, se entera por
una ✗ roja en un merge cualquiera.

**c) El deploy hay que hacerlo desde el workflow, siempre.** El MCP de Cloudflare
tiene D1, KV, R2 y lectura de Workers — **no tiene herramienta para desplegar un
Worker ni para construir una imagen**. Un paso de este plan que diga "corre
`wrangler deploy`" no se puede ejecutar allá.

**d) El dueño no usa la terminal.** Vincular el número tiene que poderse hacer
entero desde `/admin` → Conexiones, con el teléfono en la mano.

**e) El bot habla de usted.** Todo texto nuevo que pueda llegar al cliente final
—avisos de desconexión, mensajes de estado— va en usted. El tuteo es del
marketing, no de la atención.

**f) Baby Caleb tiene catálogo y reglas duras de procedencia del dato.**
`docs/FUENTES_DE_VERDAD.md` es contrato y `test/babycaleb/` lo vigila. **El canal
de QR es transporte, no contenido**: no toca precios, ni KB, ni catálogo. Correr
`pnpm test` antes y después igual.

---

## 4 · Precondiciones — antes de escribir una línea

1. **Confirmar Workers Paid con Containers** en la cuenta del cliente (Compute →
   Plans). En el plan gratis los contenedores no existen, y el error que da
   *miente*: ver §7.
2. **Agregar `Cloudflare Images: Edit`** al `CLOUDFLARE_API_TOKEN` del repo.
3. **Crear el secret `WA_QR_TOKEN`** en el repo. **Solo caracteres ASCII** —
   hexadecimal o base64url, 32+ caracteres. Esto no es cosmético: ver §7.
4. **Elegir el número.** Baileys no es oficial y WhatsApp puede banearlo. Que el
   dueño lo sepa **antes** de vincular, y que la Cloud API oficial siga conectada
   como respaldo.

---

## 5 · Las fases

### Fase 1 · El puente (el bulto del trabajo)

Worker nuevo `juancitoads-wa`, en su propia carpeta, con:

- `contenedor/Dockerfile` — **dos etapas**, y la primera instala `git` (ver §7).
- `contenedor/servidor.mjs` — Baileys + servidor HTTP interno.
- `src/worker.ts` — puente a D1, latido por alarma, rutas de QR y estado.
- D1 propia (`juancitoads-wa-auth`), **no la del bot**. La sesión de WhatsApp no
  se mezcla con los datos del negocio.
- `wrangler.toml` con `instance_type = "lite"` y **`max_instances = 1`**: dos
  sockets sobre el mismo número se tumban entre sí.

El código de PanaClaw en `humo/wa-qr/` sirve de referencia directa — está
depurado contra todos los fallos del §7.

**Hecho cuando:** se vincula un número, se mata el contenedor, y vuelve conectado
sin pedir QR.

### Fase 2 · El canal en el bot

- `"whatsapp-qr"` en `ChannelId` (`src/channels/shared.ts`).
- `src/channels/whatsappQr.ts` — `parseIncoming` y `sendReply`, con el molde de
  `twilio.ts`.
- La ruta `/webhooks/whatsapp-qr` en `src/index.ts`, validando el token.
- La línea en `pickAdapter` (`src/replies/sender.ts`).

El agente, la KB, el catálogo y los tools **no se tocan**.

**Hecho cuando:** un mensaje real entra por WhatsApp y el bot contesta.

### Fase 3 · El panel

La tarjeta en `src/admin/views/conexiones.ts`: QR en vivo para escanear desde el
teléfono, badge de estado, botón de desvincular. Manda `docs/design-system.md`
§7 — 16 px en campos, 44 px táctiles.

**Hecho cuando:** el dueño vincula su número solo, sin ayuda y sin terminal.

### Fase 4 · Operación

Enganchar el estado del canal al watchdog que ya existe, para que avise al dueño
si el número se desvincula. Y **podar las pre-keys** (ver §8).

---

## 6 · Reglas duras

- **Las credenciales van a D1.** Nunca al disco del contenedor.
- **Un solo contenedor por número.** `max_instances = 1`.
- **Un solo socket vivo.** Cerrar el anterior antes de abrir otro (ver §7).
- **El puente en su propio Worker.** No dentro del bot.
- **Nada de `wrangler deploy` a mano.** Todo por el workflow.
- **No mergear a `main` con el canal a medias.** Allá el merge despliega.

---

## 7 · Los seis fallos que ya conocemos

Cada uno costó tiempo en PanaClaw. Todos son reproducibles en Baby Caleb.

### 1. `Wrangler requires at least Node.js v22.0.0`

`package.json` trae `wrangler` en `"latest"` y el piso lo mueve wrangler solo.
**Baby Caleb ya tiene Node 22** en sus workflows — solo hay que no bajarlo.

### 2. `npm error enoent An unknown git error occurred`

**Baileys depende de `libsignal` desde un repositorio de GitHub, no desde npm**, y
`node:22-bookworm-slim` no trae `git`. El mensaje no nombra a git por ningún
lado. Además npm lo resuelve por ssh, y un build de Docker no tiene llave.

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

Segunda etapa que solo copia `node_modules`, para que `git` no viaje en la imagen
final: menos disco, y el disco se factura por GB-segundo las 24 horas.

### 3. El token llega mutado por la cabecera HTTP

**El más caro de encontrar.** El contenedor mandaba el token correcto y el Worker
esperaba el correcto, pero lo recibido tenía **el mismo largo y distinto
contenido**. Node escribe las cabeceras en latin-1 y el runtime de Cloudflare las
lee como UTF-8: un solo carácter fuera de ASCII viaja como byte suelto, es UTF-8
inválido, y se vuelve el carácter de reemplazo — uno por uno, así que el largo no
cambia y el 401 no delata nada.

**Dos defensas, poner las dos:** el token del secret **solo ASCII**, y el
contenedor lo manda **en base64** con `TextDecoder` del otro lado.

> Trampa al diagnosticar: una prueba Node-contra-Node **no reproduce esto**,
> porque ahí la codificación es simétrica y se cancela. Hay que simular el lado
> contrario o probar en el destino real.

### 4. Una promesa sin capturar mata el contenedor

`socket.ev.on("creds.update", saveCreds)` entrega una promesa que nadie atrapa.
Si el puente falla, Node 22 **termina el proceso**. Un error recuperable se
vuelve un ciclo de caídas, Cloudflare deja de entregar instancias
(*"There is no container instance that can be provided"*), y encima se pierde el
diagnóstico: un contenedor que se cae no deja ver por qué se cayó.

`.catch` en `saveCreds`, manejadores de `unhandledRejection` y
`uncaughtException` que **anotan en vez de terminar**, y espera creciente en el
latido del DO (1 → 15 min) en vez de relevantar cada minuto.

### 5. La reconexión se pelea consigo misma

`conectar()` creaba un socket nuevo **sin cerrar el anterior**. WhatsApp admite
una sola conexión por dispositivo vinculado: el nuevo expulsa al viejo, el viejo
dispara su `close`, ese `close` programa otra reconexión, y la siguiente expulsa
a la nueva. Una tormenta que se alimenta sola.

Cerrar el anterior y quitarle los listeners, numerar cada socket para ignorar
eventos de los muertos, espera creciente de 3 a 60 s, y **no reconectar ante
`loggedOut`**. El `515` (restartRequired) es aparte: es esperado tras vincular y
se atiende en 1 s.

### 6. `fetch failed` — una consulta opcional tumbando todo

`fetchLatestBaileysVersion()` sale a internet a consultar la versión del
protocolo. **Es una comodidad, no un requisito** — Baileys trae una por defecto —
pero sin `try` se vuelve un punto único de fallo: si ese host no responde, la
sesión ni se intenta aunque WhatsApp esté perfectamente alcanzable. Envolverla y
seguir.

### Y una trampa de plataforma

Desplegar un Worker con contenedores en el **plan gratis** falla con
`ApiError: Forbidden — { error: 'Authentication error' }`, que parece problema de
permisos del token y **no lo es**. Peor: llega *después* de construir la imagen.
Ante ese 403, revisar el plan primero.

---

## 8 · Cosas que se aprendieron operando

- **Un contenedor sano NO toma una imagen recién desplegada.** El latido lo ve
  `running` y lo deja en paz. Juega a favor —desplegar el puente no corta
  WhatsApp— pero para probar código nuevo **hay que matarlo**. Dejar el botón de
  matar siempre visible, no solo cuando está conectado.
- **El diagnóstico no puede depender de lo que se diagnostica.** La página de
  estado llamaba al contenedor sin tope de tiempo: cuando el contenedor se colgó,
  la página se colgó con él. Tope de tiempo, y mostrar el último error **en la
  página**, no en otra ruta.
- **Las pre-keys se acumulan.** D1 pasó de 20 KB a 561 KB con 2.473 filas. Cada
  reconexión sube un lote y nadie las limpia. Podarlas.
- **Desde una sesión de Claude no siempre se alcanza el Worker por HTTP.** La
  verificación va por el MCP de Cloudflare (listar Workers, consultar D1) o por el
  navegador del dueño. **D1 es el mejor testigo**: `creds` con fecha reciente y
  filas `lid-mapping` significan socket abierto y autenticado.

---

## 9 · Hecho cuando

- El dueño vincula su número desde `/admin` → Conexiones, con el teléfono, sin
  ayuda.
- Un mensaje real entra por WhatsApp y el bot contesta.
- Se mata el contenedor y vuelve conectado **sin pedir QR**.
- `pnpm test` verde, incluidos los de `test/babycaleb/`.
- La Cloud API oficial sigue conectada como respaldo.
- El dueño sabe que el número puede ser baneado.
