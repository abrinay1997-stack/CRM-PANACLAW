import { describe, it, expect } from "vitest";
import {
  importesDe,
  revisarCifras,
  vocabularioDeServicios,
  fuentesDelPrompt,
  pasajesDeHerramienta,
} from "../../src/replies/cifras";

/**
 * El contexto tal como lo ve el bot: el mismo formato que rinde
 * `renderBusinessContext()`, recortado a lo que importa para las cifras.
 */
const CONTEXTO = `Horarios: Lunes a viernes de 9:00 a 18:00, hora de Panamá (GMT-5).
Servicios y precios:
PanaClaw Start (una sola página): $295 · entrega en 72 h
PanaClaw Corporate (sitio de empresa): $850 · entrega en 8–12 días
Diagnóstico de Ventas: $49 · informe y llamada en 48 h
eBot (chatbot con IA): $499 pago único, sin mensualidad nuestra
Auditoría de Seguridad: $80–$150 · pago único
Seguridad mensual (Web Protegida / Web Blindada): $30–$60/mes y $70–$120/mes
Métodos de pago: 50 % al arrancar y 50 % a la entrega, precios en dólares`;

const PROMPT = `<role>Eres eBot.</role>
<business_context>
${CONTEXTO}
</business_context>
<fuente_de_verdad>REGLA DURA.</fuente_de_verdad>`;

const { pasajes, vocabulario } = fuentesDelPrompt(PROMPT, "PanaClaw");
const revisar = (respuesta: string, extra: string[] = []) =>
  revisarCifras(respuesta, [...pasajes, ...extra], vocabulario).sinRespaldo;

describe("importesDe", () => {
  it("lee las formas en que se escribe dinero aquí", () => {
    expect(importesDe("Cuesta $499 pago único.")).toEqual([499]);
    expect(importesDe("El Commerce va en $1,200.")).toEqual([1200]);
    expect(importesDe("Son 70 dólares.")).toEqual([70]);
    expect(importesDe("Unos B/. 35 al mes.")).toEqual([35]);
  });

  it("saca los dos extremos de un rango, lleve o no el segundo símbolo", () => {
    expect(importesDe("$70–$120/mes").sort((a, b) => a - b)).toEqual([70, 120]);
    expect(importesDe("El cerebro: $1–2 al mes").sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("no confunde un porcentaje ni un plazo con dinero", () => {
    expect(importesDe("50 % al arrancar y 50 % a la entrega")).toEqual([]);
    expect(importesDe("Entrega en 72 h, 8–12 días")).toEqual([]);
  });

  it("aguanta el punto final de la frase", () => {
    expect(importesDe("Son $49.")).toEqual([49]);
  });
});

describe("vocabularioDeServicios", () => {
  it("descarta el nombre del negocio, que está en todos y no distingue nada", () => {
    const vocab = vocabularioDeServicios(
      [
        "PanaClaw Start (una sola página)",
        "PanaClaw Corporate (sitio de empresa)",
        "PanaClaw Commerce (tienda en línea)",
        "eBot (chatbot con IA)",
      ],
      "PanaClaw",
    );
    expect(vocab).not.toContain("panaclaw");
    expect(vocab).toContain("start");
    expect(vocab).toContain("ebot");
  });
});

describe("revisarCifras", () => {
  /**
   * El fallo que motivó todo esto, palabra por palabra como salió por WhatsApp.
   * $70 está publicado —es el piso de Web Blindada— así que una lista blanca de
   * importes lo habría dejado pasar. Pegado a eBot, es inventado.
   */
  it("caza el precio de otro producto (el $70 de eBot)", () => {
    const respuesta =
      "Lo que sí usamos IA es en *eBot*, nuestro asistente de mensajes — de hecho, yo soy eBot. " +
      "Por $70 pago único, tu negocio puede tener un asistente como yo respondiendo WhatsApp, " +
      "Instagram o Facebook 24/7 sin costo mensual.";
    expect(revisar(respuesta)).toEqual([70]);
  });

  it("deja pasar el precio publicado del mismo producto", () => {
    const respuesta = "eBot se monta por $499, pago único y sin mensualidad nuestra.";
    expect(revisar(respuesta)).toEqual([]);
  });

  it("deja pasar lo que vino de la búsqueda en este turno", () => {
    const trozoKb =
      "eBot (chatbot para el cliente) — Cuanto cuesta eBot\n" +
      "La implementación de eBot cuesta $499 una sola vez y no lleva mensualidad nuestra. " +
      "Aparte pagas por tu cuenta: La nube donde vive — $5 al mes, se paga a Cloudflare; " +
      "El cerebro que piensa — $1–2 al mes.";
    const respuesta =
      "eBot son $499 una sola vez. Aparte pagas la nube, unos $5 al mes, y la llave de IA, $1–2 al mes.";
    expect(revisar(respuesta, [trozoKb])).toEqual([]);
  });

  it("no bloquea el $70 cuando SÍ se habla de Web Blindada", () => {
    const respuesta = "Web Blindada va de $70 a $120 al mes, sin permanencia.";
    expect(revisar(respuesta)).toEqual([]);
  });

  it("bloquea una cifra que no está publicada en ningún lado", () => {
    expect(revisar("Te lo dejo en $250 si arrancamos hoy.")).toEqual([250]);
  });

  it("sin producto de por medio, basta con que la cifra esté publicada", () => {
    expect(revisar("Lo más económico arranca en $295.")).toEqual([]);
  });

  it("una respuesta sin cifras no tiene nada que revisar", () => {
    expect(revisar("Claro, te cuento cómo trabajamos y quién revisa cada entrega.")).toEqual([]);
  });

  it("la lista blanca de importes no respalda por sí sola", () => {
    // Es el documento `web-precios`: enumera cifras sin decir de qué es cada
    // una. Si respaldara, cualquier importe publicado valdría para cualquier
    // producto — justo el agujero por el que se coló el $70.
    const listaBlanca =
      "Cifras publicadas en el sitio\n" +
      "Estos son TODOS los importes que aparecen publicados en el sitio, en dólares: " +
      "$850, $499, $295, $49, $80, $150, $70, $120, $30, $60.";
    expect(revisar("eBot te sale en $70 pago único.", [listaBlanca])).toEqual([70]);
  });
});

describe("pasajesDeHerramienta", () => {
  it("arma un pasaje por trozo de la KB, con su título", () => {
    const out = pasajesDeHerramienta("searchKb", {
      results: [{ title: "Cuanto cuesta eBot", content: "Son $499.", score: 0.9 }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Cuanto cuesta eBot");
    expect(importesDe(out[0])).toEqual([499]);
  });

  it("le devuelve la moneda al precio del catálogo, que viaja como número", () => {
    const out = pasajesDeHerramienta("catalogQuery", {
      matches: [{ name: "Camisa lino", sku: "CL-01", price: 25 }],
    });
    // Sin el símbolo, un precio real del catálogo del dueño parecería inventado.
    expect(importesDe(out[0])).toEqual([25]);
    expect(out[0]).toContain("Camisa lino");
  });

  it("ignora las herramientas que no traen datos del negocio", () => {
    expect(pasajesDeHerramienta("handoffHuman", { ticketId: "t-1" })).toEqual([]);
    expect(pasajesDeHerramienta("searchKb", undefined)).toEqual([]);
  });
});

describe("fuentesDelPrompt", () => {
  it("saca el contexto del negocio del prompt ya montado", () => {
    expect(pasajes).toContain("eBot (chatbot con IA): $499 pago único, sin mensualidad nuestra");
    expect(pasajes.some((p) => p.includes("REGLA DURA"))).toBe(false);
  });

  it("arma el vocabulario con las líneas que llevan dinero", () => {
    expect(vocabulario).toContain("ebot");
    expect(vocabulario).toContain("blindada");
    expect(vocabulario).not.toContain("panaclaw");
  });

  it("no revienta con un prompt sin contexto de negocio", () => {
    const vacio = fuentesDelPrompt("<role>Eres un bot.</role>", "PanaClaw");
    expect(vacio.pasajes).toEqual([]);
    expect(vacio.vocabulario).toEqual([]);
  });
});
