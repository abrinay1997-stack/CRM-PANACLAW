/**
 * Config de Tailwind para generar `public/admin.css`.
 *
 * Antes esto vivía como un objeto `tailwind.config` en línea dentro de
 * layout.ts, que leía el compilador de Tailwind en el navegador
 * (`cdn.tailwindcss.com`). Ese script bloqueaba el primer pintado y además
 * recorría el HTML y generaba el CSS en el teléfono del usuario, en cada carga.
 * Ahora la hoja se genera aquí, una vez, con `pnpm css:build`.
 *
 * Los colores NO se escriben aquí: salen de src/admin/views/tokens.json, el
 * mismo archivo que alimenta el bloque :root del shell. Un solo sitio.
 *
 * `content` apunta a todo lo que puede escribir una clase de Tailwind. Si
 * aparece una vista nueva fuera de estas rutas, sus clases no se generan y se
 * verá sin estilos — añádela aquí.
 */
const t = require("./src/admin/views/tokens.json");
const c = t.colors;
// Los colores leen variables CSS (`--x-rgb`) en vez de llevar el valor escrito: así el
// tema claro del panel cambia TODO, también las clases de Tailwind. El bloque :root
// con esas variables sale del mismo tokens.json (ver rootVars en layout.ts).
const v = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

module.exports = {
  content: [
    "./src/admin/**/*.ts",
    "./src/niches/**/*.ts",
  ],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        panel: v("panel"),
        panel2: v("panel2"),
        raise: v("raise"),
        line: v("line"),
        linelit: v("linelit"),
        accent: { DEFAULT: v("accent"), soft: "var(--accent-soft)" },
        accent2: v("accent-2"),
        onaccent: v("on-accent"),
        cream: v("cream"),
        muted: v("muted"),
        dim: v("dim"),
        ok: v("ok"),
        info: v("info"),
        warn: v("warn"),
        bad: v("bad"),
        violet: v("violet"),
      },
      fontFamily: {
        display: t.fonts.display.split(","),
        sans: t.fonts.display.split(","),
        mono: t.fonts.mono.split(","),
      },
    },
  },
};
