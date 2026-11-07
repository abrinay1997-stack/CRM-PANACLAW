/**
 * Tema claro opcional del panel (7-nov-2026). El oscuro sigue siendo el de siempre;
 * el claro se elige con el interruptor del menú y se recuerda en el navegador.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { layout } from "../../src/admin/views/layout";

const tokens = JSON.parse(readFileSync("src/admin/views/tokens.json", "utf8")) as {
  colors: Record<string, string>;
  claro: Record<string, string>;
};

const luminancia = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a: string, b: string) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe("tema claro: contraste legible (WCAG AA, 4.5:1)", () => {
  const c = tokens.claro;
  it("el texto sobre el fondo y sobre las tarjetas", () => {
    for (const fondo of [c.bg, c.panel, c.panel2]) {
      expect(contraste(c.cream, fondo)).toBeGreaterThanOrEqual(7);
      expect(contraste(c.muted, fondo)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(c.dim, fondo)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("el acento como texto y como botón con su texto encima", () => {
    expect(contraste(c.accent, c.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contraste(c["accent-2"], c.panel)).toBeGreaterThanOrEqual(4.5);
    expect(contraste(c["on-accent"], c.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("los colores de estado como texto sobre tarjeta blanca", () => {
    for (const k of ["ok", "info", "warn", "bad", "violet"]) {
      expect(contraste(c[k], c.panel), k).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("define los mismos colores que el oscuro (no falta ninguno)", () => {
    for (const k of Object.keys(tokens.colors)) expect(c, k).toHaveProperty(k);
  });
});

describe("tema claro: se puede elegir y se recuerda", () => {
  const html = layout({ title: "P", activeTab: "overview", body: "<p>x</p>", env: {} as any });

  it("la página trae las dos paletas y las variables rgb que usa Tailwind", () => {
    expect(html).toContain(':root[data-tema="claro"]');
    expect(html).toContain("--panel-rgb:25 10 10"); // oscuro
    expect(html).toContain("--panel-rgb:255 255 255"); // claro
    expect(html).toContain("color-scheme:light");
  });

  it("el tema se aplica antes de pintar y el menú tiene el interruptor", () => {
    expect(html).toContain("localStorage.getItem('pc-tema')");
    expect(html).toContain("window.alternarTema");
    expect(html).toContain('onclick="window.alternarTema()"');
  });

  it("el CSS generado lee las variables: cambiar de tema cambia también las clases de Tailwind", () => {
    const css = readFileSync("public/admin.css", "utf8");
    expect(css).toContain("rgb(var(--panel-rgb)");
    expect(css).not.toContain("rgb(25 10 10");
  });
});
