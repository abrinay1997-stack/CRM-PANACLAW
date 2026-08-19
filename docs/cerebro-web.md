# El sitio web es el cerebro del bot

Todo lo que el bot puede afirmar —precios, plazos, qué incluye cada plan,
horario, teléfono, enlaces— sale de **panaclaw.com**. Nada más. Si la web no lo
dice, el bot no lo sabe, y en vez de improvisar lo admite y pasa con una
persona.

No es solo una instrucción del prompt: es cómo está armado el sistema. El bot no
tiene otra fuente de la que sacarlo.

## Cómo viaja un dato desde la web hasta el chat

```
src/data/*.ts   →   /kb.json   →   member/kb/sitio-web.json   →   Vectorize   →   el bot
 (repo PanaClaw)     (la web)        (pnpm kb:sync)              (kb:reindex)
```

1. **`src/data/*.ts`** en el repo del sitio: ahí vive cada precio, una sola vez.
2. **`/kb.json`**: el sitio lo genera en cada build desde esos mismos archivos.
   Lleva los hechos ya redactados, las formas en que la gente pregunta cada
   cosa, el enlace de la página donde vive, y la lista blanca de importes
   publicados.
3. **`pnpm kb:sync`**: baja ese `/kb.json` y lo deja como documentos del bot en
   `member/kb/sitio-web.json`.
4. **`pnpm kb:reindex` + `POST /kb/reindex`**: lo mete en la memoria del bot
   (Vectorize), que es lo que consulta la herramienta `searchKb`.

Cambiar un precio son los cuatro pasos, en ese orden. Cambiarlo solo en el paso
1 deja al bot cotizando lo viejo.

## Actualizar el bot cuando cambia la web

```bash
# 1. Publica el cambio en el sitio (repo PanaClaw) y espera al deploy.

# 2. Baja la web al bot
pnpm kb:sync

# 3. Regenera el manifiesto y despliega
pnpm kb:reindex
pnpm run deploy

# 4. Mete el cambio en la memoria del bot (sin esto, sigue contestando lo viejo)
curl -X POST https://<worker>.workers.dev/kb/reindex \
  -H "X-Reindex-Token: $KB_REINDEX_TOKEN"
```

Sin conexión al sitio publicado, o para probar un cambio antes de publicarlo, se
puede sincronizar desde un build local del sitio:

```bash
cd ../PanaClaw && npm run build      # genera dist/kb.json
cd ../CRM-PANACLAW && pnpm kb:sync --from ../PanaClaw/dist/kb.json
```

`member/kb/sitio-web.json` se **reemplaza entero** en cada sincronización: si un
hecho desaparece de la web, desaparece del bot. Lo que haya escrito el dueño a
mano en otros archivos de `member/kb/` no se toca.

## Qué NO se escribe a mano

- **Precios, plazos y condiciones.** Van en el sitio. Aquí se copian solos.
- **URLs.** El bot solo manda enlaces que vengan de `member/config.local.ts` o
  de la KB. Uno inventado es un enlace roto en manos del cliente.
- **Totales.** El bot no suma ni negocia: para una cifra cerrada existe el
  cotizador (`https://panaclaw.com/cotizador/`), y para lo formal, una persona.

En `member/config.local.ts` sí hay un resumen (horario, rango de precios,
contacto, enlaces por tema). Es lo que el bot tiene siempre delante sin
buscar — un atajo, no una segunda fuente. Cuando se contradiga con la web, manda
la web y hay que corregir el resumen.

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
