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
