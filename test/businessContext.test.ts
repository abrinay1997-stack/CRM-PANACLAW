import { describe, it, expect } from "vitest";
import { renderBusinessContext, type BusinessConfig } from "../src/businessContext";

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

describe("renderBusinessContext", () => {
  it("publica el sitio web y SOLO los enlaces autorizados", () => {
    const ctx = renderBusinessContext({
      ...FIXTURE,
      website: "https://panaclaw.com",
      links: {
        "Planes y precios": "https://panaclaw.com/planes/",
        Cotizador: "https://panaclaw.com/cotizador/",
      },
    } as BusinessConfig);
    expect(ctx).toContain("Sitio web oficial: https://panaclaw.com");
    expect(ctx).toContain("Planes y precios: https://panaclaw.com/planes/");
    expect(ctx).toContain("Cotizador: https://panaclaw.com/cotizador/");
    // El encabezado es la mitad del trabajo: sin él son URLs sueltas y el
    // modelo no sabe que la lista es cerrada.
    expect(ctx).toMatch(/SOLO estos/);
  });

  it("sin enlaces configurados no imprime el encabezado vacío", () => {
    const ctx = renderBusinessContext(FIXTURE);
    expect(ctx).not.toMatch(/Enlaces que puedes pasar/);
    expect(ctx).not.toMatch(/Sitio web oficial/);
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
