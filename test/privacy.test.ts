import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderInline, renderMarkdown, renderPrivacyPage } from "../src/privacy";
import { PRIVACY_MARKDOWN } from "../src/privacy-content.generated";
import { renderModule } from "../scripts/build-privacy";

const ROOT = path.resolve(__dirname, "..");

describe("privacy-content.generated.ts", () => {
  // El módulo generado se commitea para que el repo despliegue sin acordarse de
  // regenerarlo. El precio es que puede quedarse viejo si alguien edita
  // PRIVACY.md y no corre el script — esto lo caza en CI en vez de publicar una
  // política desactualizada.
  it("está sincronizado con PRIVACY.md", () => {
    const markdown = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
    const generated = fs.readFileSync(path.join(ROOT, "src/privacy-content.generated.ts"), "utf8");
    expect(generated).toBe(renderModule(markdown));
  });

  it("conserva el texto tal cual", () => {
    const markdown = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
    expect(PRIVACY_MARKDOWN).toBe(markdown);
  });
});

describe("renderInline", () => {
  it("escapa HTML del texto original", () => {
    expect(renderInline("5 < 6 & <script>alert(1)</script>")).toBe(
      "5 &lt; 6 &amp; &lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("convierte negrita, cursiva y código", () => {
    expect(renderInline("**fuerte** y *suave* con `codigo`")).toBe(
      "<strong>fuerte</strong> y <em>suave</em> con <code>codigo</code>",
    );
  });

  // Un `**` dentro de código es texto literal, no formato: por eso los tramos de
  // código se apartan antes de aplicar negrita.
  it("no interpreta formato dentro de un tramo de código", () => {
    expect(renderInline("usa `a ** b` aquí")).toBe("usa <code>a ** b</code> aquí");
  });

  it("no se come los espacios alrededor del código", () => {
    expect(renderInline("antes `x` después")).toBe("antes <code>x</code> después");
  });

  it("deja enlaces absolutos y desarma los relativos", () => {
    expect(renderInline("[Cloudflare](https://cloudflare.com)")).toBe(
      '<a href="https://cloudflare.com" rel="noopener noreferrer">Cloudflare</a>',
    );
    // ./LICENSE es un archivo del repo: como enlace web quedaría roto.
    expect(renderInline("ver [LICENSE](./LICENSE)")).toBe("ver LICENSE");
  });
});

describe("renderMarkdown", () => {
  it("arma títulos, listas y reglas", () => {
    const html = renderMarkdown("# Título\n\n## Sección\n\n- uno\n- dos\n\n---\n");
    expect(html).toContain("<h1>Título</h1>");
    expect(html).toContain("<h2>Sección</h2>");
    expect(html).toContain("<ul><li>uno</li><li>dos</li></ul>");
    expect(html).toContain("<hr />");
  });

  it("junta las líneas seguidas en un solo párrafo", () => {
    expect(renderMarkdown("una linea\notra linea")).toBe("<p>una linea otra linea</p>");
  });

  it("arma una tabla con encabezado y filas", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(html).toContain("<th>A</th><th>B</th>");
    expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(html).toContain("<tr><td>3</td><td>4</td></tr>");
  });

  // Sin la fila separadora no es una tabla: tratarla como tal partiría el texto.
  it("una fila con pipes pero sin separador es texto normal", () => {
    const html = renderMarkdown("| esto no es tabla |");
    expect(html).toContain("<p>");
    expect(html).not.toContain("<table>");
  });

  it("vuelve a texto normal después de cerrar la tabla", () => {
    const html = renderMarkdown("| A |\n|---|\n| 1 |\n\nDespués.");
    expect(html).toContain("<p>Después.</p>");
  });
});

describe("renderPrivacyPage", () => {
  it("rinde el documento real completo", () => {
    const html = renderPrivacyPage("Mi Negocio");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Privacidad — Mi Negocio</title>");
    expect(html).toContain("Privacidad y datos");
    expect(html).toContain("<table>");
    // Nada de Markdown crudo debe sobrevivir al render.
    expect(html).not.toContain("**");
    expect(html).not.toMatch(/^#{1,6} /m);
  });

  it("funciona sin nombre de negocio", () => {
    expect(renderPrivacyPage()).toContain("<title>Privacidad</title>");
  });

  it("escapa el nombre del negocio en el título", () => {
    expect(renderPrivacyPage('<script>"x"')).toContain(
      "<title>Privacidad — &lt;script&gt;&quot;x&quot;</title>",
    );
  });
});
