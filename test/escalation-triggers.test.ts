import { describe, it, expect } from "vitest";
import { detectEscalation, stripMarkers } from "../src/escalation-triggers";

/**
 * El dueño quiere enterarse de estos temas SIEMPRE, sin que dependa de que el
 * modelo elija la tool correcta — que es exactamente como se perdió un handoff
 * real: el cliente pidió una persona, el modelo llamó a pauseBot y nadie supo.
 */

const casos: [string, string][] = [
  ["Me pueden mandar la factura del mes?", "facturacion"],
  ["necesito los datos de facturación", "facturacion"],
  ["Can you send me the invoice?", "facturacion"],
  ["quiero revisar el contrato antes de firmar", "contrato"],
  ["me pasas los términos y condiciones?", "contrato"],
  ["esto lo va a ver mi abogado", "legal"],
  ["voy a poner una demanda", "legal"],
  ["quiero un reembolso ya", "reembolso"],
  ["devuélvanme mi dinero", "reembolso"],
  ["me pueden hacer una cotización?", "cotizacion"],
  ["cuánto sale? mándame un presupuesto", "cotizacion"],
  ["ya pagué, aquí está el comprobante", "pago_declarado"],
  ["ya hice la transferencia esta mañana", "pago_declarado"],
  ["listo, quiero contratar el servicio", "intencion_contratar"],
  ["acepto la propuesta, cuándo empezamos?", "intencion_contratar"],
  ["quiero hablar con una persona", "pide_humano"],
  ["No solo comunícame con un humano", "pide_humano"],
  ["me puedes pasar con un asesor", "pide_humano"],
];

describe("detectEscalation — temas que siempre avisan", () => {
  it.each(casos)("«%s» → %s", (texto, id) => {
    expect(detectEscalation(texto)?.id).toBe(id);
  });

  it("funciona con y sin acentos, y en mayúsculas", () => {
    expect(detectEscalation("QUIERO UNA COTIZACION")?.id).toBe("cotizacion");
    expect(detectEscalation("Quiero una cotización")?.id).toBe("cotizacion");
  });

  it("avisa cuando el cliente manda una imagen, con o sin texto", () => {
    const conTexto = detectEscalation("aquí va\n[IMAGE_URL: https://x/y.jpg]");
    expect(conTexto?.id).toBe("adjunto");
    expect(conTexto?.matched).toBe("aquí va");
    expect(detectEscalation("[IMAGE_URL: https://x/y.jpg]")?.matched).toBe("(imagen sin texto)");
  });

  it("también con el aviso de imagen del tier free", () => {
    expect(
      detectEscalation("(El cliente mandó una imagen, pero tu plan no soporta análisis de imágenes.)")?.id,
    ).toBe("adjunto");
  });

  it("respeta las palabras que el dueño puso en el panel", () => {
    expect(detectEscalation("se me cayó el hosting", ["hosting"])?.id).toBe("palabra_clave");
    expect(detectEscalation("se me cayó el hosting")).toBeNull();
  });

  it("un tema conocido gana sobre la palabra del dueño", () => {
    expect(detectEscalation("quiero un reembolso del hosting", ["hosting"])?.id).toBe("reembolso");
  });

  it("no dispara con conversación normal", () => {
    for (const texto of [
      "hola, buenos días",
      "qué servicios ofrecen?",
      "tienen portafolio de sitios web?",
      "gracias, lo reviso y te aviso",
      "a qué hora abren mañana?",
    ]) {
      expect(detectEscalation(texto), texto).toBeNull();
    }
  });

  it("ignora texto vacío", () => {
    expect(detectEscalation("")).toBeNull();
    expect(detectEscalation("   ")).toBeNull();
  });
});

describe("stripMarkers", () => {
  it("quita el marcador de imagen y recorta lo muy largo", () => {
    expect(stripMarkers("hola\n[IMAGE_URL: https://x/y.jpg]")).toBe("hola");
    expect(stripMarkers("a".repeat(300))).toHaveLength(200);
  });
});
