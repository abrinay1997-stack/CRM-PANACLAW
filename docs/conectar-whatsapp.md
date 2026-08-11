# Conectar WhatsApp (oficial · Cloud API de Meta)

Guía para dejar el bot contestando por WhatsApp **sin intermediario**: directo con
Meta, sin Twilio ni ningún otro BSP. Es el camino que mejor margen deja, porque no
pagas el recargo por mensaje de un revendedor.

El bot ya trae todo el código hecho (`src/channels/whatsapp.ts` y las rutas
`/webhooks/whatsapp` en `src/index.ts`). Lo único que falta son **cuatro secrets**
y **apuntar el webhook**.

> El otro camino, WhatsApp vía Twilio (`/webhooks/twilio`), sigue disponible y no
> se toca. Los dos pueden convivir si algún día hace falta migrar sin cortar.

---

## Antes de empezar

Necesitas:

- Una **cuenta de Meta for Developers** (gratis) — https://developers.facebook.com
- Un **número de teléfono** que no esté ya registrado en la app normal de WhatsApp
  ni en WhatsApp Business. Si el número ya tiene WhatsApp, hay que borrar esa
  cuenta primero o usar otro número.
- `wrangler` funcionando en tu máquina, dentro de la carpeta del repo.

Para **probar** no hace falta nada de eso: Meta regala un número de prueba que
sirve para verificar que el circuito completo funciona. Conviene usarlo primero.

---

## Paso 1 — Crear la app en Meta

1. Entra a https://developers.facebook.com/apps y pulsa **Crear app**.
2. Tipo de app: **Empresa** (Business).
3. Ya dentro de la app, en el panel de productos, busca **WhatsApp** y pulsa
   **Configurar**.
4. Meta te pedirá asociar (o crear) una **cuenta de WhatsApp Business (WABA)**.

Al terminar caes en **WhatsApp → Configuración de la API**. Esa pantalla tiene lo
que necesitas en los pasos siguientes.

---

## Paso 2 — Recoger los cuatro datos

Anótalos en un bloc, **no los pegues en ningún chat**:

| Dato | Dónde está |
|---|---|
| **Phone Number ID** | WhatsApp → Configuración de la API, debajo del número. Es un número largo. **Ojo: NO es el número de teléfono.** |
| **Access token** | En esa misma pantalla hay un token temporal de 24 h para probar. Para producción hay que crear un **system user** con token permanente (paso 5). |
| **Verify token** | **Te lo inventas tú.** Cualquier cadena larga y aleatoria. Solo sirve para que Meta y el Worker se reconozcan en el handshake. |
| **App Secret** | Configuración de la app → **Básica** → campo *Clave secreta de la app* → "Mostrar". |

Para inventarte el verify token:

```bash
openssl rand -hex 32
```

---

## Paso 3 — Guardar los secrets en Cloudflare

Desde la raíz del repo, uno por uno. Cada comando abre un prompt donde pegas el
valor; así el valor **nunca queda en el historial de la terminal ni en git**:

```bash
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_ACCESS_TOKEN
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
```

Comprueba que quedaron los cuatro:

```bash
wrangler secret list
```

Los secrets se aplican al Worker ya desplegado; **no hace falta volver a
desplegar** salvo que hayas tocado código.

---

## Paso 4 — Apuntar el webhook

En Meta: **WhatsApp → Configuración** → sección *Webhook* → **Editar**.

- **URL de devolución de llamada:**
  ```
  https://panaclaw-oficial.abrinay1997.workers.dev/webhooks/whatsapp
  ```
- **Token de verificación:** el mismo `WHATSAPP_VERIFY_TOKEN` que guardaste.

Pulsa **Verificar y guardar**. Meta manda un `GET` al Worker; si el token
coincide, la pantalla se pone en verde. Si da error, es casi siempre que el token
no coincide exactamente (un espacio de más al copiar) o que los secrets aún no se
habían guardado.

Después, en **Campos de webhook**, pulsa **Suscribirse** en el campo **`messages`**.
Sin esa suscripción el webhook queda verificado pero **no llega ningún mensaje** —
es el fallo más común y no da ningún aviso.

---

## Paso 5 — Token permanente (antes de salir a producción)

El token de la pantalla de pruebas **caduca a las 24 horas**. Cuando caduque, el
bot deja de poder responder (los mensajes entran, pero el envío falla). Para un
token que no caduca:

1. https://business.facebook.com/settings/system-users → **Agregar** un system user
   con rol de administrador.
2. **Asignar activos** → tu app y tu WABA, con permiso de control total.
3. **Generar nuevo token** → elige la app y marca los permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`.
4. En el desplegable de caducidad elige **Nunca**.
5. Guarda ese token:
   ```bash
   wrangler secret put WHATSAPP_ACCESS_TOKEN
   ```

---

## Paso 6 — Comprobar

1. Abre `https://panaclaw-oficial.abrinay1997.workers.dev/admin` → pestaña
   **Conexiones**. La tarjeta **WhatsApp (Oficial · Cloud API)** tiene que estar en
   **verde**. Si sigue gris, ahí mismo te dice qué secret falta.
2. Manda un WhatsApp real al número. El bot debe contestar en unos segundos
   (hay un buffer de unos segundos para agrupar mensajes seguidos).
3. Abre la pestaña **Conversaciones**: la conversación tiene que aparecer con el
   canal `whatsapp`.

En cuanto llega el primer mensaje, quedan cubiertos también el audio y las
imágenes: el media entrante se sirve por un proxy firmado
(`/webhooks/whatsapp/media/:id`) para transcribirlo o mirarlo sin exponer el token.

---

## La ventana de 24 horas

Regla de Meta, no nuestra: fuera de las 24 h desde el último mensaje del cliente,
**no se puede escribir texto libre** — solo plantillas aprobadas. Dentro de la
ventana no hay límite.

Esto afecta al aviso de handoff al dueño y al bot de seguimiento. Si el aviso al
dueño tiene que salir por WhatsApp fuera de la ventana, hace falta una plantilla
aprobada; con Twilio eso es `TWILIO_HANDOFF_CONTENT_SID`. La alternativa sin
plantillas es dejar el aviso de handoff por Telegram o por correo
(`OWNER_TELEGRAM_CHAT_ID` / `RESEND_API_KEY` + `OWNER_EMAIL`).

---

## Si algo falla

| Síntoma | Causa casi siempre |
|---|---|
| Meta no verifica el webhook | El verify token no coincide, o los secrets no estaban guardados todavía |
| Webhook verificado pero no llega nada | Falta suscribir el campo **`messages`** |
| Los mensajes entran pero el bot no responde | El access token caducó (era el de 24 h) → paso 5 |
| `403 bad signature` en los logs | `WHATSAPP_APP_SECRET` no es el App Secret correcto de esa app |
| La tarjeta sigue gris en /admin | Un secret escrito con otro nombre; revísalo con `wrangler secret list` |

Para ver qué está pasando en vivo:

```bash
wrangler tail
```
