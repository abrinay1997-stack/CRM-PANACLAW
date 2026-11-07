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

  // 2-nov-2026: de usted, como pidió el dueño.
  it("la respuesta segura es de usted, no promete nada y no trae cifras", () => {
    expect(RESPUESTA_SEGURA).toMatch(/Una persona del equipo lo revisa y le responde/);
    expect(RESPUESTA_SEGURA).not.toMatch(/\d/);
    expect(revisarRespuesta(RESPUESTA_SEGURA, { formaDeTrato: "usted" })).toEqual([]);
  });
});

// 31-oct-2026: a Gabriel, que pedía un préstamo, se le preguntó «¿qué negocio
// tiene?» en seis mensajes seguidos.
describe("pregunta-repetida (corrige)", () => {
  const conPregunta = (p: string) => `Gracias, Gabriel. ${p}`;
  const anteriores = [
    conPregunta("¿Me cuenta cómo se llama su negocio?"),
    conPregunta("¿Qué negocio tienes? Así te confirmo si Start te cubre tal cual."),
  ];

  it("la tercera vez seguida la caza, aunque cambie tú por usted o las palabras", () => {
    const ps = revisarRespuesta(conPregunta("¿Me cuenta qué negocio tiene?"), { respuestasAnteriores: anteriores });
    expect(ps.map((p) => p.codigo)).toEqual(["pregunta-repetida"]);
    expect(hayQueBloquear(ps)).toBe(false);
    expect(ps[0].explicacion).toMatch(/cambia de camino/);
  });

  it("la segunda vez todavía no: se puede preguntar una vez más", () => {
    expect(codigos(conPregunta("¿Qué negocio tiene?"), { respuestasAnteriores: [anteriores[0], "Claro, aquí tiene el detalle."] })).toEqual([]);
  });

  it("preguntas distintas sobre el mismo negocio no son la misma pregunta (hallazgo de Codex)", () => {
    const seguimiento = ["¿Tu negocio ya tiene Instagram?", "¿Qué negocio tienes?"];
    expect(codigos("Perfecto. ¿Cuántos años tiene tu negocio?", { respuestasAnteriores: seguimiento })).toEqual([]);
  });

  it("las palabras de relleno no cuentan como el mismo tema", () => {
    const relleno = ["¿Quieres que te cuente más?", "¿Cuéntame, quieres avanzar?"];
    expect(codigos("¿Cuéntame qué quieres para tu web?", { respuestasAnteriores: relleno })).toEqual([]);
  });

  it("sin pregunta en la respuesta, no hay nada que repetir", () => {
    expect(codigos("Entiendo, Gabriel. Nosotros no damos préstamos; le conviene su banco.", { respuestasAnteriores: anteriores })).toEqual([]);
  });
});

// Auditoría de Meta Ads (1-nov-2026): el bot mandaba el plan completo en cuatro
// párrafos a quien solo había tocado el anuncio, y 18 de 22 no contestaron.
describe("la primera respuesta a quien tocó un anuncio", () => {
  const LARGA =
    "¡Hola! Sí, es nuestro plan *Start* con entrega rápida.\n\n" +
    "Incluye una página de varias secciones, el botón de WhatsApp y el formulario.\n\n" +
    "Se paga la mitad al empezar y la mitad al entregar.\n\n" +
    "No incluye los textos, las fotos ni el logo.\n\n" +
    "¿Qué negocio tienes y para qué quieres la web?";
  const CORTA = "¡Hola! Sí, es nuestro plan *Start*, con el precio y el plazo del anuncio.\n¿Es para un negocio que ya vende o para uno que va a abrir?";
  // 7-nov-2026: el saludo cordial cabe en la primera respuesta.
  const CON_SALUDO =
    "Buenas tardes, gracias por escribirnos a PanaClaw.\nSí, es nuestra página web *PanaClaw Start*: $295, lista en 72 horas desde que nos envía textos, fotos y la mitad del pago.\n\n¿Es para un negocio que ya vende o para uno que va a abrir?";

  it("el plan completo se rehace en 2 líneas y una pregunta cerrada", () => {
    const ps = revisarRespuesta(LARGA, { primeraDelAnuncio: true });
    const p = ps.find((x) => x.codigo === "primera-larga");
    expect(p?.gravedad).toBe("corrige");
    expect(p?.explicacion).toMatch(/2 líneas como máximo/);
    expect(p?.explicacion).toMatch(/UNA pregunta cerrada de dos opciones/);
  });

  it("dos preguntas también son demasiado", () => {
    const ps = revisarRespuesta("Sí, es el plan Start. ¿Qué negocio tiene? ¿Ya tiene logo?", { primeraDelAnuncio: true });
    expect(ps.map((x) => x.codigo)).toContain("primera-larga");
  });

  it("la corta pasa, y después de la primera no se mide", () => {
    expect(revisarRespuesta(CORTA, { primeraDelAnuncio: true }).map((x) => x.codigo)).not.toContain("primera-larga");
    expect(revisarRespuesta(CON_SALUDO, { primeraDelAnuncio: true }).map((x) => x.codigo)).not.toContain("primera-larga");
    // Sin saludo, el límite es el mismo: el saludo que se le agrega después no
    // puede volverla larga (hallazgo de Codex).
    const cuatroLineas = "Sí, es nuestra página web Start.\nSale en 72 horas.\nSe paga la mitad al empezar.\n¿Ya vende o va a abrir?";
    expect(revisarRespuesta(cuatroLineas, { primeraDelAnuncio: true }).map((x) => x.codigo)).toContain("primera-larga");
    expect(revisarRespuesta(LARGA, {}).map((x) => x.codigo)).not.toContain("primera-larga");
  });
});

// 2-nov-2026: el dueño pidió el bot de usted y más profesional. Como en Baby
// Caleb, un tuteo se rehace antes de salir.
describe("de usted", () => {
  it.each([
    "¿Qué negocio tienes y para qué quieres la web?",
    "Te cuento: el código es tuyo al terminar de pagar.",
    "¿Es para un negocio que ya vende o para uno que vas a abrir?",
    "Escríbenos cuando tengas el material.",
    "Con gusto te ayudo.",
    // Subjuntivo y pasado (hallazgo de Codex).
    "Cuando tengas el material, lo revisamos.",
    "Avísenos cuando puedas.",
    "¿Ya pagaste el adelanto?",
  ])("«%s» se rehace", (texto) => {
    const p = revisarRespuesta(texto, { formaDeTrato: "usted" }).find((x) => x.codigo === "tuteo");
    expect(p?.gravedad).toBe("corrige");
    expect(p?.explicacion).toMatch(/USTED siempre/);
  });

  it.each([
    "¿Qué negocio tiene y para qué quiere la página?",
    "Le cuento: el código queda a su nombre al pago final.",
    "¿Es para un negocio que ya vende o para uno que va a abrir?",
    "El equipo revisa su material y le escribe por aquí.",
    "Cuando tenga el material, lo revisamos. Avísenos cuando pueda.",
    "El Diagnóstico mira su negocio y le da un informe; cuando esté listo, se lo enviamos.",
    // El titular del anuncio entre comillas es una cita, no un tuteo.
    "Sí, es el anuncio «Tu página web en 72 horas»: el plan Start. ¿Ya vende o va a abrir?",
  ])("«%s» pasa", (texto) => {
    expect(revisarRespuesta(texto, { formaDeTrato: "usted" }).map((x) => x.codigo)).not.toContain("tuteo");
  });

  it("de tú, el tuteo es lo correcto", () => {
    expect(revisarRespuesta("¿Qué negocio tienes?", { formaDeTrato: "tu" }).map((x) => x.codigo)).not.toContain("tuteo");
  });
});


// 7-nov-2026: alguien tocó el anuncio «Tu página web en 72 horas», preguntó «Si de q se
// trata» y el bot contestó con el nombre del plan, el precio y el plazo, sin decir
// nunca que era una página web.
describe("la primera respuesta dice QUÉ ES lo que ofrece el anuncio", () => {
  const TITULAR = "Tu página web en 72 horas";
  const SIN_DECIR =
    "Sí, es nuestro plan *PanaClaw Start* por *$295*, listo en *72 horas* desde que nos envía textos, fotos y la mitad del pago.\n¿Es para un negocio que ya vende o para uno que va a abrir?";
  const DICIENDO =
    "Sí, es su página web profesional, lista en *72 horas* por *$295*.\n¿Es para un negocio que ya vende o para uno que va a abrir?";

  it("el caso real se rehace: nombra el plan pero no dice que es una página web", () => {
    const p = revisarRespuesta(SIN_DECIR, { primeraDelAnuncio: true, titularDelAnuncio: TITULAR }).find((x) => x.codigo === "no-dice-que-es");
    expect(p?.gravedad).toBe("corrige");
    expect(p?.explicacion).toContain("Tu página web en 72 horas");
    expect(p?.explicacion).toMatch(/QUÉ ES/);
  });

  it("si dice «página web» (o «web», o «páginas») pasa", () => {
    for (const ok of [DICIENDO, "Sí, la web de $295 queda lista en 72 horas.\n¿Ya vende?", "Sí, es una de nuestras páginas, lista en 72 horas.\n¿Ya vende?"]) {
      expect(revisarRespuesta(ok, { primeraDelAnuncio: true, titularDelAnuncio: TITULAR }).map((x) => x.codigo)).not.toContain("no-dice-que-es");
    }
  });

  it("solo mide la primera respuesta y solo si se sabe el titular", () => {
    expect(revisarRespuesta(SIN_DECIR, { titularDelAnuncio: TITULAR }).map((x) => x.codigo)).not.toContain("no-dice-que-es");
    expect(revisarRespuesta(SIN_DECIR, { primeraDelAnuncio: true }).map((x) => x.codigo)).not.toContain("no-dice-que-es");
    expect(revisarRespuesta(SIN_DECIR, { primeraDelAnuncio: true, titularDelAnuncio: null }).map((x) => x.codigo)).not.toContain("no-dice-que-es");
  });

  it("un titular de pura cifra y plazo no tiene qué exigir", () => {
    expect(revisarRespuesta("Sí, es nuestro plan Start.\n¿Ya vende?", { primeraDelAnuncio: true, titularDelAnuncio: "Desde $295 en 72 horas" }).map((x) => x.codigo)).not.toContain("no-dice-que-es");
  });

  it("otros anuncios: pide la palabra del producto de ESE anuncio", () => {
    const bot = revisarRespuesta("Sí, es nuestro plan Care por $29 al mes.\n¿Tiene sitio?", { primeraDelAnuncio: true, titularDelAnuncio: "Mantenimiento web mensual" });
    expect(bot.map((x) => x.codigo)).toContain("no-dice-que-es");
    const ok = revisarRespuesta("Sí, es el mantenimiento mensual de su web, $29.\n¿Tiene sitio?", { primeraDelAnuncio: true, titularDelAnuncio: "Mantenimiento web mensual" });
    expect(ok.map((x) => x.codigo)).not.toContain("no-dice-que-es");
  });

  it("no bloquea: se rehace una vez, nunca deja al cliente sin respuesta", () => {
    const ps = revisarRespuesta(SIN_DECIR, { primeraDelAnuncio: true, titularDelAnuncio: TITULAR });
    expect(ps.every((p) => p.gravedad !== "bloquea")).toBe(true);
  });
});
