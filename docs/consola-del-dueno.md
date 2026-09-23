# La consola del dueño por Telegram

> Para el dueño del bot. Sin terminal: todo se hace desde el panel y desde el
> teléfono.

El mismo bot de Telegram que atiende clientes es también **tu** canal con el
CRM. Por ahí te llegan los avisos —y por ahí le contestas, le das órdenes y
devuelves conversaciones al bot.

## 1. Vincular tu Telegram (una sola vez)

Hay dos caminos. **Basta uno**: no hace falta hacer los dos, ni dejar el panel
abierto después.

**A · Con el enlace del panel**

1. Panel → **Conexiones** → tarjeta **Telegram** → **Vincular mi Telegram**.
2. Abre el enlace en el teléfono donde tienes Telegram y toca **Iniciar**.
3. La tarjeta se pone en verde sola.

El código dura 15 minutos y sirve una sola vez. Si el enlace no abre, envíale al
bot el mensaje que aparece en pantalla (`/dueno 123456`).

**B · Con tu ID, como secret**

Averigua tu ID con `/miid` (o cualquier bot de ID, como @userinfobot) y ponlo
como `OWNER_TELEGRAM_CHAT_ID` en **uno** de estos dos sitios:

- **Cloudflare** → Workers & Pages → `panaclaw-oficial` → Settings → Variables
  and Secrets → Add, tipo **Secret** (no *Text*: las de tipo Text se borran en
  el siguiente despliegue).
- **GitHub** → Settings → Secrets and variables → Actions, y corre *Configurar
  y desplegar* con `solo-secrets`: lo copia a Cloudflare. Si lo pones aquí, es
  el que manda — cada despliegue pisa lo que haya en Cloudflare.

Listo: el bot protege solo su consola antes del primer aviso. El secret manda
sobre el vínculo del panel.

Para comprobarlo (opcional): **Enviarme un aviso de prueba** en la tarjeta de
Telegram. Si alguna vez un botón contesta *"Activé la protección… Toca el botón
otra vez"*, tócalo otra vez y ya: pasa solo si el webhook se re-registró a mano.

## 2. Qué te llega

| Aviso | Cuándo |
|---|---|
| 🚨 **Ticket** | Un cliente pide una persona, quiere pagar, pide factura, reclama… |
| 🛍 **Interesado** | El bot anotó a alguien con intención de compra. |
| 💬 **Te escribió** | Atiendes una conversación desde Telegram y el cliente contestó. |
| ⚠️ **Salud del bot** | El bot está fallando en cadena (rara vez). |

Cada aviso de una conversación trae **▶️ Devolver al bot**, **⏸ Pausar bot** y
**💬 Abrir en el panel**. Y **se puede responder**: toca *Responder* sobre el
aviso, escribe, y tu texto le llega al cliente por su canal. El bot queda en
pausa en esa conversación mientras la atiendes.

## 3. Comandos

| Comando | Qué hace |
|---|---|
| `/pendientes` | Tickets abiertos y conversaciones que atiende una persona. |
| `/bot #ref` | Devuelve la conversación al bot (la `#ref` sale en `/pendientes`). |
| `/pausar #ref` | Pausa el bot en esa conversación. |
| `/responder #ref texto` | Le escribe a ese cliente. |
| `/cliente` | Probar el bot como si fueras un cliente. `/dueno` para volver. |
| `/nuevo` | Que el asistente olvide lo que venían hablando y empiece de cero. |
| `/miid` | Tu chat id. |
| `/ayuda` | Esta lista. |

También puedes hablarle con tus palabras —**escritas, en nota de voz o con una
foto**—: *"¿qué tengo pendiente?"*, *"¿quién escribió hoy?"*, *"devuélvele lo de
Ana al bot"*. Un asistente interno lo entiende:

- **Sabe que eres el jefe.** Este canal es interno: seguimiento de clientes,
  trazabilidad, logística, ajustes y la operación del bot.
- **Se acuerda de lo que vienen hablando** (los últimos días). `/nuevo` para
  empezar de cero.
- **Oye notas de voz** (hasta 5 minutos) y te muestra lo que entendió (🎤 «…»)
  antes de contestar. **Ve fotos** (una captura, un comprobante).
- Una nota de voz **sobre un aviso** es una instrucción sobre ese cliente; si hay
  que decirle algo, te lo propone con botón.

Un mensaje a un cliente **siempre** te lo propone con botones: no sale sin tu
toque. Los comandos siguen igual.

## 4. Cuando contestas, el bot se calla

Da igual por dónde contestes —el panel, el **teléfono del negocio** (WhatsApp por
QR) o Telegram—: el bot se calla en esa conversación. Cuánto tiempo, lo decides
en **Config → Cuando una persona contesta** (1 hora, 4 horas o todo el día). Cada
respuesta tuya reinicia el plazo.

## 5. Seguridad

La consola solo obedece mensajes **firmados por Telegram**: el panel registra el
webhook con un secreto derivado del token del bot al vincular. Un mensaje que
diga venir de ti sin esa firma no ejecuta nada.

(Baby Caleb, que vende desde un catálogo con stock, tiene además comandos de
inventario —`/venta`, `/devolucion`, `/stock`—. Son una extensión de este mismo
módulo: `src/owner/extensiones.ts`.)
