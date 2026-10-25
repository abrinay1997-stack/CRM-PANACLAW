import { describe, it, expect } from "vitest";
import {
  revisarRespuesta,
  hayQueBloquear,
  frasesProhibidasDe,
  notaDeRevision,
  RESPUESTA_SEGURA,
} from "../../src/replies/revisor";

const codigos = (texto: string, ctx = {}) => revisarRespuesta(texto, ctx).map((p) => p.codigo);

describe("pago-confirmado (bloquea)", () => {
  it("caza un pago dado por recibido, aunque el cliente diga que ya pagó", () => {
    expect(codigos("¡Perfecto! Ya recibimos tu pago del 50 %, arrancamos mañana.")).toContain("pago-confirmado");
    expect(codigos("Tu adelanto ya está confirmado.")).toContain("pago-confirmado");
    expect(codigos("Te confirmo que recibimos tu comprobante.")).toContain("pago-confirmado");
    expect(hayQueBloquear(revisarRespuesta("Pago recibido, gracias."))).toBe(true);
  });

  it("el «sí» afirmativo no es una condición", () => {
    expect(codigos("Sí, ya recibimos tu pago. Arrancamos el lunes.")).toContain("pago-confirmado");
    expect(codigos("¡Sí! Recibimos tu comprobante.")).toContain("pago-confirmado");
  });

  it("deja pasar la regla general y la respuesta correcta", () => {
    expect(codigos("Cuando recibimos tu pago del 50 %, reservamos tu cupo y arrancamos.")).toEqual([]);
    expect(codigos("Gracias por mandarlo: una persona del equipo verifica tu pago y te confirma por aquí.")).toEqual([]);
  });
});

describe("proyecto-tocado (corrige)", () => {
  it("caza un cupo reservado o un proyecto confirmado por el bot", () => {
    expect(codigos("Listo, te reservé tu cupo para esta semana.")).toContain("proyecto-tocado");
    expect(codigos("Tu proyecto ya quedó confirmado.")).toContain("proyecto-tocado");
    expect(codigos("Ya arrancamos con tu sitio.")).toContain("proyecto-tocado");
  });

  it("no confunde «reserve» (que tú reserves) con «reservé»", () => {
    expect(codigos("Para que te reserve el cupo, una persona del equipo valida el adelanto.")).toEqual([]);
  });

  it("deja pasar la condición", () => {
    expect(codigos("Si pagas el 50 % hoy, tu cupo queda reservado.")).toEqual([]);
  });
});

describe("promesa-de-fecha (corrige)", () => {
  it("caza un día concreto para ESE cliente", () => {
    expect(codigos("Lo tienes listo el viernes.")).toContain("promesa-de-fecha");
    expect(codigos("Te escriben en unos minutos.")).toContain("promesa-de-fecha");
  });

  it("deja pasar el plazo publicado, dicho como regla", () => {
    expect(codigos("El Start se entrega en 72 horas desde que tenemos tu material y el 50 %.")).toEqual([]);
    expect(codigos("Si arrancamos hoy, lo tienes listo el viernes.")).toEqual([]);
  });
});

describe("hueco-de-plantilla y datos bancarios", () => {
  it("caza huecos y el borrador de Mejoras sin terminar", () => {
    expect(codigos("El plan cuesta (precio del plan).")).toContain("hueco-de-plantilla");
    expect(codigos("Formatos: [COMPLETA AQUÍ - especificar].")).toContain("hueco-de-plantilla");
    expect(codigos("Hola {{nombre}}")).toContain("hueco-de-plantilla");
  });

  it("caza datos de una cuenta que el bot no tiene", () => {
    expect(codigos("El número de la cuenta es 04-123-456.")).toContain("datos-bancarios");
  });
});

describe("lo que en PanaClaw sí se puede decir", () => {
  it("tutear no es un problema aquí", () => {
    expect(codigos("¡Hola! ¿Qué necesitas? Te cuento cómo funciona el Start.")).toEqual([]);
  });

  it("dar el WhatsApp cuando piden una persona tampoco", () => {
    expect(codigos("Claro: escríbenos al WhatsApp +507 6531-0721 y te atiende quien programa tu sitio.")).toEqual([]);
  });
});

describe("frases prohibidas del panel (bloquean)", () => {
  const frases = frasesProhibidasDe("te hago descuento | los precios son fijos\nprecio especial — no existe\n\nno");

  it("se leen una por línea, con su motivo, y se ignora lo demasiado corto", () => {
    expect(frases).toEqual([
      { frase: "te hago descuento", motivo: "los precios son fijos" },
      { frase: "precio especial", motivo: "no existe" },
    ]);
  });

  it("bloquean la respuesta, sin importar tildes ni mayúsculas", () => {
    const ps = revisarRespuesta("Mira, por ser tú te hago DESCUENTO.", { frasesProhibidas: frases });
    expect(ps.map((p) => p.codigo)).toContain("frase-prohibida");
    expect(hayQueBloquear(ps)).toBe(true);
    expect(ps[0].explicacion).toContain("los precios son fijos");
  });

  it("si la frase la dijo el cliente, repetirla no es romper la regla", () => {
    const ps = revisarRespuesta("Sobre el precio especial que mencionas: los precios son los publicados.", {
      frasesProhibidas: frases,
      textoDelCliente: "¿Me dan un precio especial?",
    });
    expect(ps).toEqual([]);
  });
});

describe("la nota y la respuesta segura", () => {
  it("la nota lleva el borrador, los problemas y lo que leyó", () => {
    const ps = revisarRespuesta("Ya recibimos tu pago.");
    const nota = notaDeRevision("Ya recibimos tu pago.", ps, "eBot cuesta $499.");
    expect(nota).toContain("[pago-confirmado]");
    expect(nota).toContain("Ya recibimos tu pago.");
    expect(nota).toContain("eBot cuesta $499.");
  });

  it("la respuesta segura tutea, no promete nada y no trae cifras", () => {
    expect(RESPUESTA_SEGURA).toMatch(/Te paso con una persona del equipo/);
    expect(RESPUESTA_SEGURA).not.toMatch(/\d/);
    expect(revisarRespuesta(RESPUESTA_SEGURA)).toEqual([]);
  });
});
