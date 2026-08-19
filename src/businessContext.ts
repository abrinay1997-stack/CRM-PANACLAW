import { businessConfig } from "../member/config.local";

/**
 * Los datos del negocio que acaban dentro del prompt, en `<business_context>`.
 *
 * El tipo se declara aquí y no se deduce de `member/config.local.ts` a
 * propósito: ese archivo lo edita el dueño (o el skill de instalación) y cambia
 * de negocio a negocio. Cuando el tipo salía de ahí, cualquier campo que el
 * dueño quitara rompía el tipado de `src/`. Ahora el contrato lo pone el
 * template y la configuración lo cumple; todo es opcional salvo lo que de
 * verdad no puede faltar.
 */
export interface BusinessConfig {
  hours?: string;
  /**
   * Servicios con su precio. El precio admite texto —"$30–$60/mes",
   * "desde $295"— porque muy pocos negocios tienen un número redondo por
   * servicio, y forzarlo a número obligaba a inventarse una cifra exacta ahí
   * donde el sitio publica un rango. Lo que se escriba aquí es lo que el bot
   * dice, tal cual.
   */
  services?: { name: string; price: number | string }[];
  location?: string;
  paymentMethods?: string[];
  contactPhone?: string;
  /** Sitio web del negocio. Es la fuente que el bot cita y a la que enlaza. */
  website?: string;
  /**
   * Páginas concretas a las que el bot puede mandar al cliente, por tema.
   * Existen para que el bot NUNCA arme una URL de memoria: si el enlace no está
   * en esta lista (o en la KB), no lo manda.
   */
  links?: Record<string, string>;
  customFields?: Record<string, string>;
}

/**
 * Los enlaces autorizados, que van en su PROPIA sección del prompt.
 *
 * Estuvieron dentro de `renderBusinessContext()` y ahí se perdían: el panel
 * puede sobreescribir el contexto del negocio entero (Config → "Información del
 * negocio"), y en cuanto alguien guarda ese campo, todo lo de
 * `member/config.local.ts` deja de llegar al prompt — los enlaces incluidos. El
 * bot acababa diciendo "no tengo el enlace exacto" de una página que existe y
 * está publicada, que es de las peores respuestas que puede dar: el cliente
 * pidió lo más fácil del mundo y se fue sin ello.
 *
 * Ahora salen directo del archivo de configuración, pase lo que pase con el
 * panel. Un texto libre mal editado puede empeorar una descripción; no puede
 * dejar al bot sin saber a dónde mandar a la gente.
 */
export function renderAuthorizedLinks(cfg: BusinessConfig = businessConfig): string {
  const links = Object.entries(cfg.links ?? {}).filter(([label, url]) => label && url);
  if (!links.length) return "";
  return links.map(([label, url]) => `- ${label}: ${url}`).join("\n");
}

export function renderBusinessContext(cfg: BusinessConfig = businessConfig): string {
  // Cada línea es opcional: si el miembro saltó ese dato en el onboarding, no la
  // metemos (evita "Servicios y precios:" o "Métodos de pago:" vacíos en el prompt).
  const lines: string[] = [];
  if (cfg.hours) lines.push(`Horarios: ${cfg.hours}`);
  if (cfg.services?.length) {
    lines.push(
      `Servicios y precios:\n${cfg.services
        .map((s) => `${s.name}: ${typeof s.price === "number" ? `$${s.price}` : s.price}`)
        .join("\n")}`,
    );
  }
  if (cfg.location) lines.push(`Ubicación: ${cfg.location}`);
  if (cfg.paymentMethods?.length) lines.push(`Métodos de pago: ${cfg.paymentMethods.join(", ")}`);
  if (cfg.contactPhone) lines.push(`Teléfono: ${cfg.contactPhone}`);
  if (cfg.website) lines.push(`Sitio web oficial: ${cfg.website}`);
  for (const [k, v] of Object.entries(cfg.customFields ?? {})) {
    if (v) lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}
