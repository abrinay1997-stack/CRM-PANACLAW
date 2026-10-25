# Cómo poner la IA de Meta (Muse Spark) en tu bot

Sin terminal. Son dos partes: guardar la llave en Cloudflare y elegir el modelo
en el panel.

> **La llave no se pega en ningún chat**, ni aquí ni con una IA. Va directo en
> Cloudflare.

## Antes de empezar

Necesitas tu llave de la IA de Meta, la de **dev.meta.ai**.

No sirven el token de la Página de Facebook (empieza con `EAA…`) ni el de
Instagram (`IGAA…`): esos son para recibir mensajes, no abren la IA.

## 1 · Guardar la llave en Cloudflare (una sola vez)

1. Entra a **dash.cloudflare.com** → **Workers & Pages** → **panaclaw-oficial**.
2. Ve a **Settings** → **Variables and Secrets** → **+ Add**.
3. Llena así:
   - **Type:** `Secret`
   - **Variable name:** `META_API_KEY`
   - **Value:** tu llave de dev.meta.ai
4. Pulsa **Deploy** para guardar.

## 2 · Elegir Muse Spark en el panel

1. Abre `https://panaclaw-oficial.abrinay1997.workers.dev/admin` → **Configuración** → **Modelo de IA**.
2. **Proveedor:** «Muse Spark (Meta)».
3. **Modelo:** «Muse Spark Contributor».
4. Deja **vacío** el campo «Tu API key»: la llave ya está en Cloudflare.
5. Pulsa **Guardar**.
6. Pulsa **«Probar mi configuración»**. Debe decir «✓ Conexión exitosa».

Mientras tengas el Contributor elegido, el panel muestra un aviso fijo: Meta
entrena sus modelos con lo que le llega, o sea, con las conversaciones de tus
clientes. Si algún día no lo quieres, elige «Muse Spark 1.3», que cuesta más pero
no entrena con tus datos.

## Si algo falla

- **La prueba sale en rojo:** el mensaje dice por qué. Casi siempre es una llave
  equivocada (la de la Página en vez de la de dev.meta.ai).
- **La prueba sale en verde pero el bot contesta «Algo falló de mi lado»:** en
  **Configuración → Modelo de IA** aparece un recuadro rojo, «Último fallo real
  del bot», con el error exacto que devolvió Meta.
- **Si Meta falla en un mensaje, contesta Claude como respaldo**, con la llave de
  Anthropic que ya está en Cloudflare. El bot no se queda mudo.

## Volver a Claude

En **Configuración → Modelo de IA**, elige «Claude (Anthropic)» como proveedor (o
«Automático») y guarda. La llave de Meta puede quedarse guardada en Cloudflare
sin estorbar.

## Otra forma: desde GitHub

Si prefieres guardar la llave en GitHub en vez de Cloudflare:

1. Ve a **Settings → Secrets and variables → Actions → New repository secret**.
2. Ponle de nombre `META_API_KEY` y de valor tu llave.
3. Corre la Action **«Configurar y desplegar»** con la opción `secrets-y-deploy`.

Después haz la parte 2.
