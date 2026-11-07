import { describe, it, expect } from "vitest";
import {
  renderSystemPrompt,
  systemPromptFromEnv,
  type SystemPromptInput,
} from "../src/system-prompt";

const input: SystemPromptInput = {
  botName: "Asistente",
  businessName: "Barbería Centro",
  language: "es",
  businessContext: "Horarios: Lun-Sáb 10am-8pm\nUbicación: Monterrey",
  toolList: ["searchKb", "handoffHuman", "pauseBot"],
};

describe("renderSystemPrompt", () => {
  it("contains all 10 sections", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("<output_language>");
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("<business_context>");
    expect(prompt).toContain("<identity_and_voice>");
    expect(prompt).toContain("<core_principles>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("<escalation_rules>");
    expect(prompt).toContain("<style_guide>");
    expect(prompt).toContain("<anti_patterns>");
  });

  it("replaces every placeholder (none left)", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).not.toContain("{{");
    expect(prompt).not.toContain("}}");
  });

  it("interpolates language, bot name and business name", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("es");
    expect(prompt).toContain("Asistente");
    expect(prompt).toContain("Barbería Centro");
  });

  it("renders tool list as bullet lines", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("- handoffHuman");
    expect(prompt).toContain("- pauseBot");
  });

  it("injects business context", () => {
    const prompt = renderSystemPrompt(input);
    expect(prompt).toContain("Horarios: Lun-Sáb 10am-8pm");
  });

  it("inserts nichoPlaybook when provided and empty string when omitted", () => {
    const withPlaybook = renderSystemPrompt({
      ...input,
      nichoPlaybook: "<diagnostic_playbooks>X</diagnostic_playbooks>",
    });
    expect(withPlaybook).toContain("<diagnostic_playbooks>X</diagnostic_playbooks>");
    // omitted -> the placeholder is gone, replaced by ""
    const withoutPlaybook = renderSystemPrompt(input);
    expect(withoutPlaybook).not.toContain("{{NICHO_PLAYBOOK}}");
  });
});

/*
 * Las reglas que sostienen la promesa del bot: no inventa nada y no manda
 * enlaces que no le hayan dado. Se comprueban por su presencia en el prompt
 * porque es lo único verificable sin llamar al modelo — pero que estén
 * escritas es condición necesaria, y borrarlas por accidente al editar el
 * template es exactamente el fallo que este test detiene.
 */
describe("reglas de atención y anclaje a la fuente", () => {
  const prompt = renderSystemPrompt(input);

  it("declara las secciones de atención al cliente y de fuente de verdad", () => {
    expect(prompt).toContain("<fuente_de_verdad>");
    expect(prompt).toContain("<atencion_al_cliente>");
    expect(prompt).toContain("<enlaces_y_cotizaciones>");
    expect(prompt).toContain("<disponibilidad>");
  });

  it("obliga a buscar antes de afirmar y a admitir lo que no sabe", () => {
    expect(prompt).toContain("searchKb");
    expect(prompt).toMatch(/NO EXISTE/);
    expect(prompt).toContain("handoffHuman");
  });

  it("prohíbe inventar URLs y calcular totales", () => {
    expect(prompt).toMatch(/URL que no venga de <enlaces_autorizados>/);
    expect(prompt).toMatch(/No sumes totales/);
    expect(prompt).toMatch(/Sumar, calcular o negociar un total/);
  });

  it("prohíbe prometer atención humana fuera de horario", () => {
    expect(prompt).toMatch(/fuera del horario de atención/i);
    expect(prompt).toContain("<ahora>");
  });
});

/*
 * La regresión que se comió una venta: un cliente pidió «solo pásame el enlace»
 * de los planes y el bot contestó que no lo tenía, de una página publicada y
 * funcionando. La causa no fue el modelo: los enlaces vivían dentro del
 * contexto del negocio, y ese contexto lo reemplaza entero el campo del panel.
 * En cuanto alguien guarda ahí su propio texto, los enlaces desaparecían.
 *
 * Por eso llegan por su propia vía y se prueban por su propia vía.
 */
describe("enlaces autorizados", () => {
  const LINKS = "- Planes: https://panaclaw.com/planes/\n- Cotizador: https://panaclaw.com/cotizador/";

  it("sobreviven aunque el contexto del negocio venga del panel", () => {
    const prompt = renderSystemPrompt({
      ...input,
      businessContext: "lo que el dueño escribió a mano en el panel, sin un solo enlace",
      authorizedLinks: LINKS,
    });
    expect(prompt).toContain("<enlaces_autorizados>");
    expect(prompt).toContain("https://panaclaw.com/planes/");
    expect(prompt).toContain("https://panaclaw.com/cotizador/");
  });

  it("obliga a mirar la lista antes de decir que no hay enlace", () => {
    const prompt = renderSystemPrompt({ ...input, authorizedLinks: LINKS });
    expect(prompt).toMatch(/ANTES de decir que no tienes un enlace/);
    expect(prompt).toMatch(/Si anuncias un enlace, PÉGALO/);
  });

  it("prohíbe prometer que el bot manda correos o cotizaciones", () => {
    const prompt = renderSystemPrompt({ ...input, authorizedLinks: LINKS });
    expect(prompt).toMatch(/lo hace UNA PERSONA/);
    expect(prompt).toMatch(/Decir que TÚ mandas un correo/);
  });

  it("sin enlaces configurados no deja una sección vacía", () => {
    const prompt = renderSystemPrompt(input);
    // Se comprueba el CONTENIDO del bloque, no su nombre: las reglas de
    // <enlaces_y_cotizaciones> nombran a <enlaces_autorizados> para mandarte a
    // mirarlo, así que el nombre aparece en el prompt aunque el bloque no.
    expect(prompt).not.toContain("Los ÚNICOS enlaces que puedes mandar");
    expect(prompt).not.toContain("{{ENLACES}}");
  });
});

/*
 * Un cliente real escribió «Donde están ubicados para ir» —seco, sin saludo— y
 * el bot contestó solo con la negativa: «no tenemos oficina física ni reuniones
 * presenciales». Cierto a medias (sí hay videollamadas y visitas) y sin saludo.
 * El dueño no pudo mandar esa respuesta y la escribió a mano.
 *
 * Se comprueba la presencia de las reglas, que es lo verificable sin llamar al
 * modelo. Borrarlas al recortar el prompt es el fallo que estos tests detienen.
 */
describe("trato con clientes secos o desconfiados", () => {
  const prompt = renderSystemPrompt(input);

  it("saluda aunque el cliente no salude", () => {
    expect(prompt).toMatch(/aunque el cliente no haya saludado/);
    expect(prompt).toMatch(/no se condiciona a que la ponga él primero/);
  });

  it("no confunde un mensaje seco con un cliente molesto", () => {
    expect(prompt).toMatch(/es prisa, no\s+enojo/);
    expect(prompt).toMatch(/NUNCA le señales el tono/);
  });

  it("lee el cuestionamiento como interés, no como ataque", () => {
    expect(prompt).toMatch(/Eso es interés, no\s+ataque/);
    expect(prompt).toMatch(/sin defenderte y sin discutir/);
  });

  it("exige que toda negativa lleve la alternativa en el mismo mensaje", () => {
    expect(prompt).toMatch(/nunca solas/);
    expect(prompt).toMatch(/lo que SÍ hay en su lugar/);
    expect(prompt).toMatch(/Cortar en el «no» suena a puerta cerrada/);
  });

  it("permite cerrar cuando la respuesta fue un no", () => {
    expect(prompt).toMatch(/cuando la respuesta fue un «no»/);
    expect(prompt).toContain("deje la puerta abierta");
  });

  // El tono que el dueño configura en el panel se suma a estas reglas; no las
  // reemplaza. Un tono "formal y usted" no autoriza a contestar cortante.
  it("mantiene las reglas cuando el dueño define un tono propio", () => {
    const conTono = renderSystemPrompt({ ...input, tone: "muy formal y de usted" });
    expect(conTono).toContain("Adopta un estilo muy formal y de usted");
    expect(conTono).toMatch(/aunque el cliente no haya saludado/);
    expect(conTono).toMatch(/lo que SÍ hay en su lugar/);
  });
});

describe("systemPromptFromEnv", () => {
  it("pulls botName/businessName/language from env", () => {
    const env = {
      BOT_NAME: "Bot",
      BUSINESS_NAME: "Acme",
      BOT_LANGUAGE: "en",
    } as any;
    const prompt = systemPromptFromEnv(env, ["searchKb"], "ctx here");
    expect(prompt).toContain("Bot");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("en");
    expect(prompt).toContain("- searchKb");
    expect(prompt).toContain("ctx here");
  });
});

// 25-oct-2026: con Muse Spark, cada respuesta empezaba con «Te respondo en
// español — busco la info…». El prompt pedía avisar el cambio de idioma «al
// principio» y mencionaba la narración de antes de las tools.
describe("idioma y narración", () => {
  const prompt = renderSystemPrompt({ botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb"] });

  it("solo avisa del idioma si el cliente escribe en otro", () => {
    expect(prompt).not.toMatch(/Acknowledge the switch once at the start/);
    expect(prompt).toMatch(/only in that case and only\s+once/);
    expect(prompt).toMatch(/never mention the language at all/);
  });

  it("no narra lo que va a buscar", () => {
    expect(prompt).toMatch(/Never narrate what you are about to do/);
  });

  it("la regla del anuncio es para la primera respuesta, no para todas", () => {
    expect(prompt).toMatch(/Esto vale para tu PRIMERA respuesta a esa persona/);
  });
});

// 25-oct-2026, segunda prueba del dueño: al «vi el anuncio de $295 en 72 horas»
// el bot contestó bien pero en cuatro párrafos (qué incluye, pago, lo que no
// incluye) y cerró con una pregunta Y un enlace a los planes.
describe("el primer mensaje a quien llega de un anuncio", () => {
  const prompt = renderSystemPrompt({ botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb"] });

  // 1-nov-2026, auditoría de Meta Ads: 18 de 22 no contestaron el plan
  // completo. Ahora: 2 líneas y una pregunta cerrada de dos opciones.
  it("confirma plan, precio y plazo en 2 líneas y cierra con una pregunta cerrada de dos opciones", () => {
    expect(prompt).toMatch(/PRIMER mensaje empieza con un saludo cordial según la hora y las gracias\s+por escribir/);
    expect(prompt).toMatch(/2 líneas\s+como máximo y UNA pregunta cerrada, de dos opciones/);
    expect(prompt).toMatch(/confírmalo con el precio y el\s+plazo publicados/);
    expect(prompt).toMatch(/Nada de listas, beneficios ni enlaces en ese mensaje/);
    expect(prompt).not.toMatch(/cabe en 2 a 4 líneas/);
    expect(prompt).not.toMatch(/dile qué es, cuánto cuesta, en cuánto se entrega y qué\s+incluye/);
  });

  it("una pregunta frecuente tocada en el anuncio se contesta tal cual, corta, desde la KB", () => {
    expect(prompt).toMatch(/botones de\s+preguntas frecuentes/);
    expect(prompt).toMatch(/contesta ESO, con lo que diga searchKb, en\s+2 líneas como máximo/);
    expect(prompt).toMatch(/«quiero\s+empezar» o algo así, no le expliques el plan: dile el primer paso/);
  });

  it("el plan completo solo si lo pide o ya sabe su negocio, y lo que no incluye antes de comprometerse", () => {
    expect(prompt).toMatch(/El plan completo \(lo que incluye, cómo se paga, lo que NO incluye\) solo\s+cuando lo pida/);
    expect(prompt).toMatch(/Lo que no\s+incluye nunca se esconde/);
    expect(prompt).toMatch(/antes de que se comprometa/);
  });

  it("no escribe cifras en el prompt: el precio y el plazo salen de la KB", () => {
    const bloque = prompt.slice(prompt.indexOf("<quien_llega_de_un_anuncio>"), prompt.indexOf("</quien_llega_de_un_anuncio>"));
    expect(bloque).not.toMatch(/\$\s?\d/);
    expect(bloque).not.toMatch(/\d+ horas/);
  });

  it("sin enlace en el primer mensaje, y nunca pregunta y enlace a la vez", () => {
    expect(prompt).toMatch(/Sin enlaces en el primer mensaje, salvo que pida la página/);
    expect(prompt).toMatch(/no le pegues detrás un enlace que no pidió/);
  });
});

// 25-oct-2026: el dueño pidió un vendedor, no solo un asistente: que busque el
// dolor, persuada sin presionar, escriba corto y en formato de WhatsApp.
describe("cómo vende", () => {
  const prompt = renderSystemPrompt({ botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb", "captureLead", "handoffHuman"] });

  it("trae las reglas de venta", () => {
    expect(prompt).toContain("<como_vender>");
    expect(prompt).toMatch(/Primero el dolor, después el plan/);
    expect(prompt).toMatch(/Recomienda UNA opción/);
    expect(prompt).toMatch(/Urgencia, solo la verdadera/);
    expect(prompt).toMatch(/Cierra cada mensaje con UN siguiente paso concreto/);
  });

  it("escribe en el formato de WhatsApp y con pocos emojis", () => {
    expect(prompt).toMatch(/negrita es con UN asterisco/);
    expect(prompt).not.toMatch(/Markdown OK/);
    expect(prompt).toMatch(/Como mucho uno por mensaje, y no en todos/);
  });
});


// 27-oct-2026, conversaciones reales: Graciela tocó el anuncio sin querer y
// pidió que la borraran; Mike buscaba empleo y quedó como dos leads y un
// ticket; a Ismael se le preguntó cinco veces qué negocio tenía, entre tú y
// usted.
describe("quien no viene a comprar, y no presionar", () => {
  const prompt = renderSystemPrompt({ botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb", "captureLead", "handoffHuman"] });

  it("a quien no le interesa no se le vende más", () => {
    expect(prompt).toContain("<quien_no_viene_a_comprar>");
    expect(prompt).toMatch(/no le\s+volverán a escribir y no le vendas nada más/);
  });

  it("borrar los datos lo hace una persona, y el bot no afirma qué se guarda", () => {
    expect(prompt).toMatch(/se lo pasas al equipo para borrarlos, y llama handoffHuman/);
    expect(prompt).toMatch(/No afirmes qué datos guarda o\s+no guarda el negocio/);
  });

  it("quien busca empleo o vende algo no es un lead ni abre ticket", () => {
    expect(prompt).toMatch(/NO uses captureLead \(no es un\s+lead\), no abras un ticket y no prometas que alguien lo va a contactar/);
  });

  it("no repite la pregunta que no le contestaron, y ofrece una llamada", () => {
    expect(prompt).toMatch(/No repitas la pregunta que no te contestó/);
    expect(prompt).toMatch(/ofrécele una llamada corta con el equipo/);
  });

  it("si le hablan de usted, sigue de usted", () => {
    expect(prompt).toMatch(/sigue de usted hasta el final/);
  });
});

// 31-oct-2026: Gabriel, jubilado, pedía un préstamo de $2.000 y salió como lead,
// con el plan ofrecido en cada mensaje y «el equipo lo contacta el lunes».
describe("quien busca algo que no vendemos", () => {
  const prompt = renderSystemPrompt({ botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb", "captureLead"] });

  it("se le dice una vez, se le orienta y no se le vuelve a ofrecer el plan", () => {
    expect(prompt).toMatch(/Si busca algo que el negocio no vende/);
    expect(prompt).toMatch(/No le\s+vuelvas a ofrecer el plan salvo que él pregunte por la web, y no lo anotes\s+como lead/);
  });

  it("«ya usted me dirá» no es un sí, y el lead va una sola vez", () => {
    expect(prompt).toMatch(/«Ya usted me dirá», «dígame usted» o\s+«está bien» no son un sí/);
    expect(prompt).toMatch(/captureLead va una sola vez por conversación/);
  });

  it("a quien no entiende, más corto y simple", () => {
    expect(prompt).toMatch(/escríbele más corto y simple: una idea por\s+mensaje/);
  });
});

// 2-nov-2026: sin una forma de trato elegida, la regla de siempre; con ella,
// el bloque manda y no queda ningún ejemplo de tuteo para copiar.
describe("forma de trato", () => {
  const base = { botName: "PanaClaw", businessName: "PanaClaw", language: "es", businessContext: "", toolList: ["searchKb"] };

  it("de usted: el bloque va pegado al idioma, con los ejemplos MAL/BIEN de una agencia", () => {
    const prompt = renderSystemPrompt({ ...base, formaDeTrato: "usted" });
    expect(prompt.indexOf("<forma_de_trato>")).toBeGreaterThan(prompt.indexOf("</output_language>"));
    expect(prompt.indexOf("<forma_de_trato>")).toBeLessThan(prompt.indexOf("<role>"));
    expect(prompt).toContain('BIEN: "¿Qué negocio tiene y para qué quiere la página?"');
    expect(prompt).toMatch(/sin «¡Genial!», «¡Perfecto!» ni «¡Súper!»/);
    expect(prompt).toMatch(/El trato es el de <forma_de_trato>, sin excepciones/);
    expect(prompt).toMatch(/Tono amable, directo y profesional/);
    expect(prompt).not.toMatch(/para tu caso es Y/);
  });

  it("sin elegir, se habla según como le hablen (instalaciones viejas)", () => {
    const prompt = renderSystemPrompt(base);
    expect(prompt).not.toContain("<forma_de_trato>");
    expect(prompt).not.toContain("<ultimo_recordatorio>");
    expect(prompt).toMatch(/Habla de tú o de usted según como te hablen/);
  });
});

describe("quien llega de un anuncio: la primera frase dice qué es", () => {
  it("el prompt pide nombrar lo que ofrece el anuncio, no solo el plan", () => {
    const prompt = renderSystemPrompt(input);
    const bloque = prompt.slice(prompt.indexOf("<quien_llega_de_un_anuncio>"), prompt.indexOf("</quien_llega_de_un_anuncio>"));
    expect(bloque).toContain("Tu primera frase dice QUÉ ES");
    expect(bloque).toContain("un nombre de plan a secas no le dice nada");
    expect(bloque).toContain("«¿de qué se trata?»");
  });
});
