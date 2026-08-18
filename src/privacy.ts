/**
 * Página pública de privacidad (`GET /privacidad`).
 *
 * Existe porque Meta exige una URL pública de política de privacidad para
 * publicar una app — y sin app publicada, WhatsApp Cloud API no entrega
 * mensajes de producción. Servirla desde el propio Worker evita depender de un
 * hosting extra y la deja bajo el dominio del bot.
 *
 * El texto viene de PRIVACY.md a través del módulo generado; aquí solo se
 * convierte a HTML. El renderizador cubre EXACTAMENTE lo que ese documento usa
 * (títulos, listas, tablas, reglas, negrita/cursiva/código/enlaces) en vez de
 * arrastrar una librería de Markdown a un Worker.
 */
import { PRIVACY_MARKDOWN } from "./privacy-content.generated";

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

/**
 * Convierte el formato *dentro* de una línea. El orden importa: primero se
 * escapa el HTML, luego se apartan los tramos de código (para que un `**` que
 * viva dentro de código no se vuelva negrita), y al final se reinyectan.
 *
 * El centinela lleva `%%` a ambos lados en vez de espacios: así no se traga el
 * espaciado de alrededor y es improbable que aparezca en el texto real.
 */
export function renderInline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `%%CODE${codes.length - 1}%%`;
  });

  // Los enlaces relativos (./LICENSE) apuntan a archivos del repo y quedarían
  // rotos en la web: se conserva el texto y se descarta el destino.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) =>
    /^https?:\/\//i.test(href)
      ? `<a href="${href}" rel="noopener noreferrer">${label}</a>`
      : label,
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return out.replace(/%%CODE(\d+)%%/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** Parte una fila `| a | b |` en sus celdas. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line: string) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);

export function renderMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      html.push(`<ul>${list.map((li) => `<li>${renderInline(li)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    // Tabla: una fila seguida del separador |---|---|. Sin separador es texto.
    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushAll();
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      i--; // el for vuelve a incrementar
      html.push(
        `<div class="tabla"><table><thead><tr>${head
          .map((c) => `<th>${renderInline(c)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flushAll();
      html.push("<hr />");
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushAll();
  return html.join("\n");
}

/** La página completa: pública, sin auth y sin datos de nadie. */
export function renderPrivacyPage(businessName?: string): string {
  const body = renderMarkdown(PRIVACY_MARKDOWN);
  const title = businessName ? `Privacidad — ${escapeHtml(businessName)}` : "Privacidad";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="/favicon.svg" />
<style>
  :root {
    --fondo: #ffffff; --texto: #1a1a1a; --tenue: #5c5c5c;
    --acento: #FF5100; --linea: #e6e6e6; --caja: #f7f7f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #131313; --texto: #ededed; --tenue: #a3a3a3;
      --acento: #FF7A3D; --linea: #2e2e2e; --caja: #1d1d1d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.25rem 5rem;
    background: var(--fondo); color: var(--texto);
    font: 16px/1.7 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 2rem; line-height: 1.25; margin: 0 0 2rem; }
  h2 { font-size: 1.3rem; margin: 2.5rem 0 .75rem; }
  a { color: var(--acento); }
  hr { border: 0; border-top: 1px solid var(--linea); margin: 2.5rem 0; }
  code {
    background: var(--caja); border: 1px solid var(--linea); border-radius: 4px;
    padding: .1em .35em; font-size: .875em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  ul { padding-left: 1.25rem; }
  li { margin: .4rem 0; }
  /* Las tablas del documento son anchas; que scrollee la tabla y no la página. */
  .tabla { overflow-x: auto; margin: 1.25rem 0; }
  table { border-collapse: collapse; width: 100%; min-width: 32rem; font-size: .925rem; }
  th, td { border: 1px solid var(--linea); padding: .55rem .7rem; text-align: left; vertical-align: top; }
  th { background: var(--caja); font-weight: 600; }
  footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--linea); color: var(--tenue); font-size: .875rem; }
</style>
</head>
<body>
<main>
${body}
<footer>Esta página la sirve el propio bot. No registra visitas ni usa cookies.</footer>
</main>
</body>
</html>`;
}
