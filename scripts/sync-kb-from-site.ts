#!/usr/bin/env tsx
/**
 * sync-kb-from-site.ts
 *
 * Baja la base de conocimiento que publica el sitio (`/kb.json`) y la deja en
 * `member/kb/` como documentos del bot.
 *
 * POR QUÉ EXISTE
 * --------------
 * La web es el cerebro. Todo lo que el bot puede decir —precios, plazos, qué
 * incluye cada plan, horario, teléfono— ya está escrito una vez en el sitio, y
 * el sitio lo publica generado desde sus propios archivos de datos. Copiar esas
 * cifras a mano en la configuración del bot crea una segunda verdad que se
 * desincroniza el primer día que alguien cambia un precio en la web: a partir
 * de ahí el bot cotiza lo que ya no cobramos, y nadie se entera hasta que un
 * cliente reclama.
 *
 * Con este script hay UNA sola fuente. Se cambia el precio en la web, se
 * publica, se corre esto y el bot ya sabe lo nuevo. Lo que el sitio no diga, el
 * bot no lo sabe — y eso es deliberado: es la única forma de que "no inventes
 * nada" sea una propiedad del sistema y no un ruego dentro del prompt.
 *
 * CÓMO SE USA
 * -----------
 *   pnpm kb:sync                      # baja de la web publicada
 *   pnpm kb:sync --from ../PanaClaw/dist/kb.json   # desde un build local
 *   pnpm kb:reindex                   # regenera scripts/kb-fixtures.json
 *   curl -X POST https://<worker>/kb/reindex -H "X-Reindex-Token: $KB_REINDEX_TOKEN"
 *
 * Los tres pasos van juntos: este script solo escribe archivos; hasta que no se
 * reindexa Vectorize, el bot sigue contestando con lo viejo.
 *
 * QUÉ ESCRIBE
 * -----------
 * Un solo archivo, `member/kb/sitio-web.json`, que se REEMPLAZA entero en cada
 * corrida (si un hecho desaparece de la web, desaparece del bot). El resto de
 * `member/kb/` no se toca: lo que el dueño escriba a mano ahí convive con esto.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_FILE = resolve(ROOT, "member/kb/sitio-web.json");

/** Un hecho tal como lo publica el sitio en /kb.json. */
export interface SiteFact {
  id: string;
  topic: string;
  /** Formas en que la gente pregunta esto. Alimentan la búsqueda. */
  q: string[];
  /** La respuesta ya redactada, con sus cifras. */
  text: string;
  /** Página del sitio donde vive el hecho. */
  url?: string;
}

export interface SiteKb {
  generatedAt?: string;
  site: {
    name: string;
    location?: string;
    whatsapp?: string;
    url?: string;
    horario?: string;
    timezone?: string;
  };
  prices?: string[];
  facts: SiteFact[];
}

/** Documento tal como lo consume `generate-fixtures.ts`. */
export interface KbDocument {
  id: string;
  title: string;
  content: string;
}

const TOPIC_LABEL: Record<string, string> = {
  planes: "Planes y precios",
  capacidades: "Capacidades que se suman a un plan",
  ebot: "eBot (chatbot para el cliente)",
  seguridad: "Seguridad",
  mantenimiento: "Mantenimiento (Care)",
  servicios: "Servicios",
  proceso: "Cómo trabajamos",
  proyectos: "Proyectos y ejemplos",
  faq: "Preguntas frecuentes",
  contacto: "Contacto",
  legal: "Privacidad y legal",
};

/** Título legible del hecho. Sale en los resultados de searchKb, así que se lee. */
function titleFor(fact: SiteFact): string {
  const label = TOPIC_LABEL[fact.topic] ?? fact.topic;
  const primera = fact.q.find((q) => q.trim().length > 0)?.trim();
  if (!primera) return label;
  return `${label} — ${primera.charAt(0).toUpperCase()}${primera.slice(1)}`;
}

/**
 * Texto que se embebe y que el modelo acaba leyendo.
 *
 * Lleva las tres cosas a propósito:
 *  • la respuesta redactada (lo que el bot parafrasea),
 *  • las formas de preguntarlo (la búsqueda es semántica, pero acertar es más
 *    fácil cuando el trozo contiene las palabras con las que preguntan),
 *  • y el enlace, para que el bot pase la página en vez de inventarse una URL.
 */
export function documentFromFact(fact: SiteFact): KbDocument {
  const partes = [fact.text.trim()];
  const preguntas = fact.q.map((q) => q.trim()).filter(Boolean);
  if (preguntas.length) {
    partes.push(`Responde también a: ${preguntas.join("; ")}.`);
  }
  if (fact.url) {
    partes.push(`Página con esta información: ${fact.url}`);
  }
  return {
    id: `web-${fact.id}`,
    title: titleFor(fact),
    content: partes.join("\n\n"),
  };
}

/**
 * La ficha del negocio, primer documento del archivo.
 *
 * Va aparte de los hechos porque responde a lo que más se pregunta por chat
 * —"¿a qué hora atienden?", "¿dónde están?", "¿me pasas la web?"— y en el sitio
 * eso no es un hecho de ninguna página: es la cabecera de /kb.json.
 */
export function documentFromSite(kb: SiteKb): KbDocument {
  const s = kb.site;
  const lineas = [`${s.name} es una agencia web${s.location ? ` en ${s.location}` : ""}.`];
  if (s.url) lineas.push(`Sitio web oficial: ${s.url}`);
  if (s.horario) lineas.push(`Horario de atención: ${s.horario}${s.timezone ? ` (${s.timezone})` : ""}.`);
  if (s.whatsapp) lineas.push(`WhatsApp: ${s.whatsapp}`);
  lineas.push(
    "Fuera de ese horario el chat sigue contestando, pero una persona del equipo responde al " +
      "siguiente día hábil.",
  );
  return {
    id: "web-negocio",
    title: `${s.name} — datos del negocio, horario y contacto`,
    content: lineas.join("\n"),
  };
}

/** Lista blanca de importes publicados, para que el dueño pueda auditarla. */
export function documentFromPrices(kb: SiteKb): KbDocument | null {
  const prices = (kb.prices ?? []).filter(Boolean);
  if (!prices.length) return null;
  return {
    id: "web-precios",
    title: "Cifras publicadas en el sitio",
    content:
      "Estos son TODOS los importes que aparecen publicados en el sitio, en dólares: " +
      prices.map((p) => `$${p}`).join(", ") +
      ".\n\nCualquier cifra distinta a estas no está publicada: no se le da al cliente. " +
      "Si pide un total que mezcla varias cosas, se le pasa el cotizador en vez de sumar.",
  };
}

export function documentsFrom(kb: SiteKb): KbDocument[] {
  const docs: KbDocument[] = [documentFromSite(kb)];
  const precios = documentFromPrices(kb);
  if (precios) docs.push(precios);
  for (const fact of kb.facts) docs.push(documentFromFact(fact));
  return docs;
}

/** Falla temprano y con un mensaje que se entiende sin leer este archivo. */
export function assertKbShape(data: unknown): asserts data is SiteKb {
  const kb = data as SiteKb;
  if (!kb || typeof kb !== "object") throw new Error("kb.json no es un objeto JSON.");
  if (!kb.site?.name) throw new Error("kb.json no trae site.name — ¿es el kb.json del sitio?");
  if (!Array.isArray(kb.facts) || kb.facts.length === 0) {
    throw new Error("kb.json no trae hechos (facts). No se sobreescribe la KB con nada.");
  }
}

async function loadKb(source: string): Promise<SiteKb> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${source} respondió ${res.status}`);
    raw = await res.text();
  } else {
    const file = resolve(ROOT, source);
    if (!existsSync(file)) throw new Error(`No existe ${file}`);
    raw = readFileSync(file, "utf8");
  }
  const data = JSON.parse(raw) as unknown;
  assertKbShape(data);
  return data;
}

/**
 * De dónde se baja.
 *
 * Orden: `--from` (build local, sirve sin internet) → `SITE_KB_URL` → el sitio
 * del negocio declarado en member/config.local.ts. Nunca hay un dominio escrito
 * aquí: si el negocio cambia de dominio, se cambia en un sitio y este script lo
 * sigue.
 */
async function resolveSource(argv: string[]): Promise<string> {
  const fromIdx = argv.indexOf("--from");
  if (fromIdx !== -1) {
    const value = argv[fromIdx + 1];
    if (!value) throw new Error("--from necesita una ruta o URL.");
    return value;
  }
  if (process.env.SITE_KB_URL) return process.env.SITE_KB_URL;
  const { businessConfig } = (await import("../member/config.local")) as {
    businessConfig: { website?: string };
  };
  const web = businessConfig.website?.trim();
  if (!web) {
    throw new Error(
      "No sé de dónde bajar la KB: pon `website` en member/config.local.ts, " +
        "o pasa --from <ruta|url>, o define SITE_KB_URL.",
    );
  }
  return new URL("/kb.json", web).href;
}

async function main(): Promise<void> {
  const source = await resolveSource(process.argv.slice(2));
  console.log(`⤓  Bajando la base de conocimiento de ${source}`);
  const kb = await loadKb(source);
  const docs = documentsFrom(kb);

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(docs, null, 2) + "\n", "utf8");

  console.log(
    `✅ ${docs.length} documento(s) escritos en member/kb/sitio-web.json ` +
      `(${kb.facts.length} hechos del sitio${kb.generatedAt ? `, generados ${kb.generatedAt}` : ""}).`,
  );
  console.log("ℹ️  Falta llevarlo al bot:\n" + "    pnpm kb:reindex\n" +
    '    curl -X POST https://<worker>/kb/reindex -H "X-Reindex-Token: $KB_REINDEX_TOKEN"');
}

const INVOKED_DIRECTLY =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  main().catch((e) => {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
