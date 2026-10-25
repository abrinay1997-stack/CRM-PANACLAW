import { describe, it, expect } from "vitest";
import { formatoWhatsApp, esWhatsApp, sinNarracion } from "../../src/replies/formato";
import { chunkReply } from "../../src/replies/chunker";

// Los casos salen de la prueba del dueño con Muse Spark (25-oct-2026).
describe("sinNarracion", () => {
  const NARRACION = "Te respondo en español — busco la info del plan de $295 para compartirte los detalles.";
  const RESPUESTA = "¡Hola! Sí, es nuestro plan PanaClaw Start — $295 y entrega en 72 horas.";

  it("quita lo que el modelo dijo antes de buscar", () => {
    const steps = [
      { text: NARRACION, toolCalls: [{ toolName: "searchKb" }] },
      { text: RESPUESTA, toolCalls: [] },
    ];
    expect(sinNarracion(steps)).toBe(RESPUESTA);
  });

  it("deja la respuesta que vino ANTES de anotar el lead, aunque después diga algo corto", () => {
    const larga =
      "¡Perfecto, Pilar! Para arrancar con el Start necesitamos tus textos, tus imágenes y tu logo si ya lo tienes. " +
      "El pago es 50 % al empezar y 50 % a la entrega, y el plazo de 72 horas cuenta desde que tenemos todo eso. " +
      "Una persona del equipo te escribe por aquí para coordinar.";
    const steps = [
      { text: larga, toolCalls: [{ toolName: "captureLead" }] },
      { text: "Listo.", toolCalls: [] },
    ];
    expect(sinNarracion(steps)).toBe(`${larga}\n\nListo.`);
  });

  it("con un solo paso que habló no toca nada", () => {
    expect(sinNarracion([{ text: RESPUESTA, toolCalls: [] }])).toBeNull();
    expect(sinNarracion([{ text: "", toolCalls: [{}] }, { text: RESPUESTA }])).toBeNull();
    expect(sinNarracion([{ toolCalls: [] }])).toBeNull();
  });

  it("entre dos respuestas deja un párrafo, no las pega", () => {
    const steps = [{ text: "Uno.", toolCalls: [] }, { text: "Dos.", toolCalls: [] }];
    expect(sinNarracion(steps)).toBe("Uno.\n\nDos.");
  });
});

describe("formatoWhatsApp", () => {
  it("la negrita de Markdown pasa a la de WhatsApp", () => {
    expect(formatoWhatsApp("**1. Sitios web** — los 4 planes")).toBe("*1. Sitios web* — los 4 planes");
    expect(formatoWhatsApp("- **Start $295** (72 horas)")).toBe("- *Start $295* (72 horas)");
  });

  it("los títulos y los enlaces de Markdown quedan legibles", () => {
    expect(formatoWhatsApp("## Qué incluye\nTodo.")).toBe("*Qué incluye*\nTodo.");
    expect(formatoWhatsApp("Mira [los planes](https://panaclaw.com/planes/).")).toBe(
      "Mira los planes: https://panaclaw.com/planes/.",
    );
  });

  it("no toca las viñetas con un asterisco ni el texto normal", () => {
    const texto = "Incluye:\n\n* 4 a 5 secciones\n* Publicación incluida\n\nPrecio: $295.";
    expect(formatoWhatsApp(texto)).toBe(texto);
  });

  it("solo en los canales de WhatsApp", () => {
    expect(esWhatsApp("whatsapp")).toBe(true);
    expect(esWhatsApp("whatsapp-qr")).toBe(true);
    expect(esWhatsApp("telegram")).toBe(false);
  });
});

describe("chunkReply con más párrafos que globos", () => {
  it("el último globo conserva sus párrafos", () => {
    const texto = "Hola.\n\nUno.\n\nDos.\n\nTres.";
    expect(chunkReply(texto, 3)).toEqual(["Hola.", "Uno.", "Dos.\n\nTres."]);
  });
});
