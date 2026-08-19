// member/config.local.ts
// Configuración del negocio. La edita el dueño (o el skill
// /configurar-mi-chatbot). NUNCA se sobreescribe al actualizar el template.
//
// Este es el bot oficial de PanaClaw. TODOS los datos de aquí salen del sitio
// panaclaw.com — no se escribe nada que la web no diga. Si un precio cambia,
// cambia primero en la web y después aquí (o mejor: se corre `pnpm kb:sync`,
// que baja la web entera a la base de conocimiento del bot).

export const memberConfig = {
  businessName: "PanaClaw",
  botName: "PanaClaw",
  language: "es" as "es" | "en",
  tier: "pro" as "free" | "pro",
  timezone: "America/Panama",
  contactEmail: "hola@panaclaw.com",
};

export type MemberConfig = typeof memberConfig;

/**
 * Contexto del negocio que renderiza src/businessContext.ts dentro del prompt.
 *
 * Es el resumen que el bot tiene SIEMPRE delante, sin tener que buscar. Lo
 * detallado —qué incluye cada plan, plazos, preguntas frecuentes— vive en la
 * base de conocimiento que baja de panaclaw.com/kb.json, y el bot lo consulta
 * con searchKb. Aquí solo va lo que se pregunta a cada rato: horario, rango de
 * precios, cómo se contacta y a qué página mandar a cada quien.
 */
export const businessConfig = {
  /*
   * Horario de atención HUMANA, igual que el publicado en el sitio
   * (data/site.ts → contact.horario). El chat contesta a cualquier hora; lo que
   * se respeta de noche es el seguimiento proactivo — ver src/followup/hours.ts.
   */
  hours: "Lunes a viernes de 9:00 a 18:00, hora de Panamá (GMT-5). Sábados, domingos y feriados no hay atención humana; el chat sigue respondiendo y una persona del equipo contesta al siguiente día hábil.",

  services: [
    { name: "PanaClaw Start (una sola página)", price: "$295 · entrega en 72 h" },
    { name: "PanaClaw Launch (landing a medida)", price: "$450 · entrega en 4–5 días" },
    { name: "PanaClaw Corporate (sitio de empresa)", price: "$850 · entrega en 8–12 días" },
    { name: "PanaClaw Commerce (tienda en línea)", price: "$1,200 · entrega en 15–20 días" },
    { name: "Diagnóstico de Ventas", price: "$49 · informe y llamada en 48 h" },
    { name: "eBot (chatbot con IA)", price: "$499 pago único, sin mensualidad nuestra" },
    { name: "Auditoría de Seguridad", price: "$80–$150 · pago único" },
    { name: "Seguridad mensual (Web Protegida / Web Blindada)", price: "$30–$60/mes y $70–$120/mes" },
    { name: "PanaClaw Care (mantenimiento)", price: "Base $35/mes · Pro $75/mes · Business $150–$250/mes" },
    { name: "Capacidades sueltas (cuentas, panel, reservas, portal, integraciones, inventario)", price: "$350–$750 según cuál" },
  ],

  location: "Panamá. Trabajamos 100 % en remoto para todo el país; no hay oficina que visitar.",
  paymentMethods: ["50 % al arrancar y 50 % a la entrega", "precios en dólares"],
  contactPhone: "+1 (940) 604-6565",
  website: "https://panaclaw.com",

  /**
   * Enlaces autorizados. El bot solo manda estos (o los que traiga la KB del
   * sitio); cualquier otra URL sería inventada.
   */
  links: {
    "Planes y precios": "https://panaclaw.com/planes/",
    "Cotizador (precio en 4 preguntas)": "https://panaclaw.com/cotizador/",
    "Servicios y mantenimiento": "https://panaclaw.com/servicios/",
    "Seguridad web": "https://panaclaw.com/seguridad/",
    "eBot (chatbot)": "https://panaclaw.com/ebot/",
    "Proyectos y ejemplos": "https://panaclaw.com/proyectos/",
    "Cómo trabajamos": "https://panaclaw.com/proceso/",
    "Preguntas frecuentes": "https://panaclaw.com/ayuda/",
    Contacto: "https://panaclaw.com/contacto/",
    Privacidad: "https://panaclaw.com/privacidad/",
  },

  customFields: {
    "Qué hacemos":
      "Sitios web rápidos (abren en menos de un segundo), entregados en días y con el código a nombre del cliente. También chatbot con IA (eBot), auditorías de seguridad y mantenimiento mensual.",
    "Cómo cotizamos":
      "El cotizador del sitio da el precio en cuatro preguntas y muestra el desglose y la fecha de entrega: https://panaclaw.com/cotizador/. El bot NO suma totales a mano ni improvisa descuentos.",
    "De quién es el trabajo":
      "El código es del cliente: al pago final se le transfiere el repositorio a su cuenta de GitHub y el dominio queda a su nombre.",
  } as Record<string, string>,
};

// Catálogo de productos que consume src/tools/catalogQuery.ts (tier Pro).
// PanaClaw no vende artículos con SKU: lo que se vende son los planes de arriba
// y está todo publicado en panaclaw.com/planes/, así que el catálogo va vacío a
// propósito y el bot responde de precios con la base de conocimiento del sitio.
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];
