import { describe, it, expect } from "vitest";
import {
  renderAuthorizedLinks,
  renderBusinessContext,
  type BusinessConfig,
} from "../src/businessContext";

// Fixture propio: el test NO depende de member/config.local.ts (ese archivo
// cambia por negocio y antes rompía la suite cada vez que se personalizaba).
const FIXTURE: BusinessConfig = {
  hours: "Lunes a sábado de 10 a 8",
  services: [
    { name: "Corte", price: 250 },
    { name: "Barba", price: 200 },
    { name: "Corte + Barba", price: 400 },
  ],
  location: "Av. Reforma 123, CDMX",
  paymentMethods: ["efectivo", "transferencia", "tarjeta"],
  contactPhone: "+52 55 1234 5678",
  customFields: { Estacionamiento: "sí, gratis" },
} as BusinessConfig;

describe("renderAuthorizedLinks", () => {
  it("lista los enlaces con su etiqueta, listos para el prompt", () => {
    const out = renderAuthorizedLinks({
      ...FIXTURE,
      links: {
        "Planes y precios": "https://panaclaw.com/planes/",
        Cotizador: "https://panaclaw.com/cotizador/",
      },
    } as BusinessConfig);
    expect(out).toBe(
      "- Planes y precios: https://panaclaw.com/planes/\n- Cotizador: https://panaclaw.com/cotizador/",
    );
  });

  it("devuelve vacío cuando no hay enlaces, para no dejar una sección hueca", () => {
    expect(renderAuthorizedLinks(FIXTURE)).toBe("");
    expect(renderAuthorizedLinks({ ...FIXTURE, links: {} } as BusinessConfig)).toBe("");
  });

  it("descarta las entradas a medias en vez de emitir una URL vacía", () => {
    const out = renderAuthorizedLinks({
      ...FIXTURE,
      links: { Planes: "https://panaclaw.com/planes/", Rota: "" },
    } as BusinessConfig);
    expect(out).toBe("- Planes: https://panaclaw.com/planes/");
  });
});

describe("renderBusinessContext", () => {
  it("publica el sitio web del negocio", () => {
    const ctx = renderBusinessContext({
      ...FIXTURE,
      website: "https://panaclaw.com",
    } as BusinessConfig);
    expect(ctx).toContain("Sitio web oficial: https://panaclaw.com");
  });

  it("sin sitio web no imprime la línea vacía", () => {
    expect(renderBusinessContext(FIXTURE)).not.toMatch(/Sitio web oficial/);
  });

  /*
   * Los enlaces salieron de aquí a propósito: este texto lo puede reemplazar
   * entero el panel, y con ellos dentro el bot se quedaba sin saber a dónde
   * mandar a la gente. Que NO estén aquí es la mitad del arreglo.
   */
  it("no mete los enlaces en el contexto — viven en su propia sección", () => {
    const ctx = renderBusinessContext({
      ...FIXTURE,
      links: { Planes: "https://panaclaw.com/planes/" },
    } as BusinessConfig);
    expect(ctx).not.toContain("https://panaclaw.com/planes/");
  });

  it("respeta los precios escritos como texto (rangos, 'desde', mensualidades)", () => {
    const ctx = renderBusinessContext({
      ...FIXTURE,
      services: [
        { name: "Sitio Start", price: "$295 · entrega en 72 h" },
        { name: "Care Base", price: "$35/mes" },
        { name: "Corte", price: 250 },
      ],
    } as BusinessConfig);
    expect(ctx).toContain("Sitio Start: $295 · entrega en 72 h");
    expect(ctx).toContain("Care Base: $35/mes");
    // El número suelto sigue llevando su símbolo, como siempre.
    expect(ctx).toContain("Corte: $250");
  });

  it("renders hours, services with prices, location, payment, phone", () => {
    const ctx = renderBusinessContext(FIXTURE);
    expect(ctx).toContain("Horarios:");
    expect(ctx).toContain("Servicios y precios:");
    expect(ctx).toContain("Corte: $250");
    expect(ctx).toContain("Barba: $200");
    expect(ctx).toContain("Corte + Barba: $400");
    expect(ctx).toContain("Ubicación:");
    expect(ctx).toContain("Métodos de pago:");
    expect(ctx).toContain("Teléfono:");
  });

  it("joins payment methods with comma", () => {
    const ctx = renderBusinessContext(FIXTURE);
    expect(ctx).toContain("efectivo, transferencia, tarjeta");
  });
});
