/**
 * Sincronización web → base de conocimiento del bot.
 *
 * Lo que se prueba aquí es la conversión: qué acaba viendo el modelo cuando el
 * cliente pregunta un precio. Si un hecho pierde su cifra, sus formas de
 * preguntarlo o su enlace por el camino, el bot deja de poder responder
 * exactamente lo que la web ya dice — y el fallo no se nota hasta que un
 * cliente pregunta.
 */
import { describe, it, expect } from "vitest";
import {
  assertKbShape,
  documentFromFact,
  documentFromPrices,
  documentFromSite,
  documentsFrom,
  type SiteKb,
} from "../../scripts/sync-kb-from-site";

const KB: SiteKb = {
  generatedAt: "2026-08-19T12:00:00.000Z",
  site: {
    name: "PanaClaw",
    location: "Panamá",
    whatsapp: "+1 (940) 604-6565",
    url: "https://panaclaw.com/",
    horario: "Lun–Vie · 9:00 – 18:00",
    timezone: "Hora de Panamá (GMT-5)",
  },
  prices: ["295", "1,200"],
  facts: [
    {
      id: "plan-start",
      topic: "planes",
      q: ["cuanto cuesta PanaClaw Start", "lo mas barato"],
      text: "PanaClaw Start cuesta $295. Entrega 72 h.",
      url: "https://panaclaw.com/planes/",
    },
  ],
};

describe("documentFromFact", () => {
  const doc = documentFromFact(KB.facts[0]);

  it("conserva la respuesta con su cifra, tal cual la publica el sitio", () => {
    expect(doc.content).toContain("PanaClaw Start cuesta $295");
  });

  it("lleva las formas de preguntarlo, que es lo que hace que se encuentre", () => {
    expect(doc.content).toContain("cuanto cuesta PanaClaw Start");
    expect(doc.content).toContain("lo mas barato");
  });

  it("lleva el enlace de la página, para que el bot no se invente la URL", () => {
    expect(doc.content).toContain("https://panaclaw.com/planes/");
  });

  it("el id no choca con documentos escritos a mano por el dueño", () => {
    expect(doc.id).toBe("web-plan-start");
  });

  it("el título dice de qué es, porque searchKb se lo enseña al modelo", () => {
    expect(doc.title).toContain("Planes y precios");
  });

  it("un hecho sin enlace no inventa uno", () => {
    const sinUrl = documentFromFact({ ...KB.facts[0], url: undefined });
    expect(sinUrl.content).not.toContain("http");
  });
});

describe("documentFromSite y documentFromPrices", () => {
  it("la ficha del negocio trae horario, contacto y sitio", () => {
    const doc = documentFromSite(KB);
    expect(doc.content).toContain("https://panaclaw.com/");
    expect(doc.content).toContain("Lun–Vie · 9:00 – 18:00");
    expect(doc.content).toContain("+1 (940) 604-6565");
    expect(doc.content).toContain("Panamá");
  });

  it("la lista de cifras publicadas sale con su símbolo", () => {
    expect(documentFromPrices(KB)!.content).toContain("$295, $1,200");
  });

  it("sin cifras publicadas no se escribe un documento vacío", () => {
    expect(documentFromPrices({ ...KB, prices: [] })).toBeNull();
  });
});

describe("documentsFrom", () => {
  it("empieza por la ficha del negocio y no pierde ningún hecho", () => {
    const docs = documentsFrom(KB);
    expect(docs[0].id).toBe("web-negocio");
    expect(docs).toHaveLength(KB.facts.length + 2); // + negocio + precios
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length); // ids únicos
  });
});

/*
 * La KB del bot se REEMPLAZA entera en cada sincronización. Por eso lo que
 * llega mal se rechaza antes de escribir nada: una respuesta a medias del
 * servidor no puede dejar al bot sin saber sus propios precios.
 */
describe("assertKbShape", () => {
  it("acepta un kb.json bien formado", () => {
    expect(() => assertKbShape(KB)).not.toThrow();
  });

  it.each([
    ["no es un objeto", null],
    ["no trae el negocio", { facts: KB.facts }],
    ["viene sin hechos", { site: KB.site, facts: [] }],
    ["los hechos no son una lista", { site: KB.site, facts: "muchos" }],
  ])("rechaza cuando %s", (_caso, data) => {
    expect(() => assertKbShape(data)).toThrow();
  });
});
