# Prueba de humo — WhatsApp por QR

**Esto es descartable.** No es parte del bot y no se despliega con él. Existe
para contestar con hechos las preguntas abiertas de
[`docs/bitacora-whatsapp-qr.md`](../../docs/bitacora-whatsapp-qr.md), y después
se borra.

## Qué prueba, exactamente

| # | Pregunta | Cómo la contesta |
|---|---|---|
| 1 | ¿La cuenta tiene Workers Paid con Containers? | Si no, el deploy falla con `Forbidden` |
| 2 | ¿Cuánto factura el Durable Object en 24 h? | El latido corre 1.440 veces/día; se compara contra el panel de Cloudflare |
| 3 | **¿Reconecta sin pedir QR nuevo?** | `/matar` tumba el contenedor; el latido lo levanta |
| 4 | ¿La imagen construye en un runner de GitHub? | El workflow la construye y la empuja |
| 5 | ¿El token sirve para Images/Containers? | El `wrangler deploy` del workflow lo ejercita |

La #3 es la que decide todo. Si tras matar el contenedor hay que volver a
escanear, el canal no sirve para un cliente: Cloudflare mueve contenedores
cuando quiere, y nadie va a estar escaneando un QR cada vez.

## Cómo corre

Todo desde la pestaña **Actions**, sin terminal.

1. Guarda el secret **`HUMO_TOKEN`** en el repo (Settings → Secrets and
   variables → Actions). Cualquier cadena larga que te inventes.
2. Confirma que `CLOUDFLARE_API_TOKEN` tenga **Cloudflare Images: Edit** además
   de lo que ya tenía. Sin eso no se puede empujar la imagen.
3. Actions → **"Prueba de humo · WhatsApp por QR"** → Run workflow → `desplegar`.
4. Abre **desde el teléfono**:
   `https://panaclaw-wa-humo.abrinay1997.workers.dev/qr?t=<HUMO_TOKEN>`
5. Escanea con WhatsApp → Dispositivos vinculados → Vincular dispositivo.
6. Cuando diga **Vinculado**, viene la prueba de verdad:

   ```
   POST /matar?t=<HUMO_TOKEN>
   ```

   Espera un minuto y recarga `/estado?t=<HUMO_TOKEN>`.

**Pasó si** `contenedor.conexion` vuelve a `"conectada"`, `arranquesContenedor`
subió en 1, y **nunca apareció un QR nuevo**. Fíjate también en
`credencialesVenianDeD1: true` — es la prueba de que leyó la sesión de la base y
no empezó de cero.

## Cómo se ve por dentro

```
 Teléfono ──escanea una vez──┐
                             ▼
 WhatsApp ◄══ wss 24/7 ══► CONTENEDOR (lite)
                             │  Baileys + servidor HTTP :8080
                             │
                             │ HTTPS + token (no tiene bindings)
                             ▼
                          WORKER  ──► D1 `panaclaw-wa-humo`
                             ▲          tabla wa_humo_auth
                             │
                        alarma cada 60 s
                   (mantiene vivo el DO y relevanta
                    el contenedor si se cayó)
```

Las credenciales **nunca tocan el disco** del contenedor. Ese es el cambio de
fondo contra la versión de BukoFlow en Railway, donde vivían en
`./whatsapp-auth/` y había que respaldarlas a mano en la variable `WA_AUTH`.

## Rutas

Todas piden `?t=<HUMO_TOKEN>` (o la cabecera `x-humo-token`).

| Ruta | Qué hace |
|---|---|
| `GET /qr` | La página con el QR. Se refresca sola cada 5 s. |
| `GET /estado` | JSON con el estado del socket, el diario del DO y cuántas filas hay en D1 |
| `POST /matar` | Tumba el contenedor — **la prueba** |
| `POST /logout` | Desvincula el número y borra las credenciales |
| `GET /health` | Sin token, para saber si el Worker está arriba |

## Cómo se borra

1. Actions → el mismo workflow → `borrar-todo`. Eso quita el Worker, el Durable
   Object y el contenedor.
2. La base D1 `panaclaw-wa-humo` **no** se borra ahí a propósito: guarda la
   sesión de WhatsApp. Bórrala a mano desde el panel de Cloudflare cuando ya no
   la necesites.
3. Desvincula el número desde el teléfono (WhatsApp → Dispositivos vinculados).
4. Borra esta carpeta y `.github/workflows/humo-wa-qr.yml`.

## Advertencia

Baileys no es oficial: WhatsApp puede banear el número que vincules. **Usa un
número que puedas perder** — no el de producción de un cliente, ni el tuyo
principal.
