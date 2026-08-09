# `public/` — archivos estáticos del panel

Todo lo que vive aquí se sirve **tal cual** desde la raíz del Worker. Un archivo
`public/logo.svg` queda en `https://<tu-worker>.workers.dev/logo.svg`.

No hay paso de compilación: lo que subes es lo que se publica.

## Qué hay hoy

| Archivo | Dónde se usa |
|---|---|
| `logo.svg` | la marca del panel, arriba a la izquierda del menú |
| `favicon.svg` | el icono de la pestaña del navegador |
| `favicon-32.png` | respaldo para navegadores que no leen SVG |
| `apple-touch-icon.png` | el icono al guardar el panel en la pantalla de un teléfono |

Los cuatro son **los mismos archivos del sitio de PanaClaw**, así que el panel y
la página web se ven de la misma familia.

## Cambiar el logo

Pisa `logo.svg` con el tuyo y vuelve a desplegar (`pnpm run deploy`). No hay que
tocar código: el panel lo lee de esta ruta.

Tres cosas que conviene respetar para que no se vea raro:

1. **Que sea SVG.** Se dibuja a 34 px en el menú y más grande en la pantalla de
   entrada; un PNG chico se ve borroso en pantallas retina.
2. **Que la silueta llene el lienzo**, sin márgenes vacíos alrededor. Si el SVG
   trae aire de sobra, el logo se ve diminuto dentro de su caja.
3. **Que el color sea sólido.** El de hoy va pintado de `#FF5100` (el naranja de
   la marca) directo en el atributo `fill` del `<svg>`. Si el tuyo trae otro
   color y quieres que siga el acento del panel, cambia ese `fill` a
   `currentColor` y heredará el token `--accent` automáticamente.

Si vas a cambiar también el favicon, reemplaza los tres archivos de icono, no
solo el SVG — cada navegador elige uno distinto.

## De dónde salieron

Los originales del logo viven en el repo del sitio
(`PanaClaw/brand-assets/`), junto con la receta para regenerar los iconos si
algún día cambia el tratamiento.
