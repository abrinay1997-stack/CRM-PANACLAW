/**
 * Pre-deploy check. Dos mitades, y la división importa:
 *
 *  - Los validadores exportados (`validateDeployConfig`, `checkResources`) son
 *    PUROS: reciben datos y devuelven errores. Sin red, sin proceso, sin disco.
 *    Por eso se pueden testear sin montar nada.
 *  - El bloque `isMain` es el que sale al mundo: lee wrangler.toml y le pregunta
 *    a Cloudflare qué existe. Todo va en try/catch — si no hay red o no hay
 *    login, sigue con lo que pudo averiguar.
 *
 * Regla de oro de este archivo: **no se bloquea un deploy por algo que no se
 * pudo comprobar.** Un check que falla cuando el usuario está en un avión es
 * peor que el bug que previene.
 */

export interface DeployConfig {
  ANTHROPIC_API_KEY?: string;
  BOT_NAME?: string;
  BOT_TIER?: string;
  DASHBOARD_PASSWORD?: string;
  // at least one customer channel:
  TELEGRAM_BOT_TOKEN?: string;
  MANYCHAT_API_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  [k: string]: string | undefined;
}

export interface DeployCheckResult {
  ok: boolean;
  errors: string[];
}

/** Pure validator — easy to unit test, no process/network access. */
export function validateDeployConfig(cfg: DeployConfig): DeployCheckResult {
  const errors: string[] = [];

  if (!cfg.ANTHROPIC_API_KEY) errors.push("Falta ANTHROPIC_API_KEY (Claude API).");
  if (!cfg.BOT_NAME) errors.push("Falta BOT_NAME.");
  if (!cfg.BOT_TIER) errors.push("Falta BOT_TIER ('free' | 'pro').");

  const hasChannel = Boolean(
    cfg.TELEGRAM_BOT_TOKEN || cfg.MANYCHAT_API_KEY || cfg.TWILIO_ACCOUNT_SID,
  );
  if (!hasChannel) {
    errors.push(
      "No hay ningún canal configurado: define al menos TELEGRAM_BOT_TOKEN, MANYCHAT_API_KEY o TWILIO_ACCOUNT_SID.",
    );
  }

  if (cfg.BOT_TIER === "pro" && !cfg.DASHBOARD_PASSWORD) {
    errors.push("BOT_TIER=pro requiere DASHBOARD_PASSWORD (Basic Auth del dashboard).");
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Recursos: que lo que pide el toml exista de verdad
 * ------------------------------------------------------------------ */

/**
 * Por qué existe esta mitad del archivo.
 *
 * D1 se enlaza por id, pero **Vectorize y R2 se enlazan por NOMBRE**. Si el
 * nombre del toml no coincide con lo que hay en la cuenta, `wrangler deploy`
 * falla al FINAL —con todo lo demás ya hecho— y con un `index not found` que
 * parece un fallo del código y es un nombre mal escrito.
 *
 * Peor todavía es el índice creado con otras dimensiones: ahí no falla nada.
 * El deploy sale verde, el bot contesta, y la búsqueda no encuentra jamás nada
 * porque los vectores de la consulta y los del índice no viven en el mismo
 * espacio. Es el único fallo de esta lista que no da la cara nunca, así que se
 * comprueba aquí.
 */
export const KB_DIMENSIONS = 1024;

export interface ResourceNames {
  databaseName?: string;
  databaseId?: string;
  indexName?: string;
  bucketName?: string;
}

/** Lo que hay en la cuenta. `null` = no se pudo averiguar (sin red / sin login). */
export interface ResourceInventory {
  d1: string[] | null;
  vectorize: { name: string; dimensions?: number }[] | null;
  r2: string[] | null;
}

/** Saca del wrangler.toml los nombres que el deploy va a exigir. */
export function parseResourceNames(toml: string): ResourceNames {
  const pick = (key: string): string | undefined =>
    toml.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m"))?.[1];
  return {
    databaseName: pick("database_name"),
    databaseId: pick("database_id"),
    indexName: pick("index_name"),
    bucketName: pick("bucket_name"),
  };
}

/**
 * Compara lo que el toml pide contra lo que la cuenta tiene.
 *
 * Un inventario en `null` NO produce error: significa que no se pudo mirar, y
 * eso no es lo mismo que "no existe".
 */
export function checkResources(
  names: ResourceNames,
  inv: ResourceInventory,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (names.databaseId?.includes("{{")) {
    errors.push(
      `wrangler.toml todavía tiene el marcador ${names.databaseId} en database_id. ` +
        `Crea la base (wrangler d1 create ${names.databaseName ?? "<database_name>"}) y pega el id real.`,
    );
  }

  if (inv.d1 && names.databaseName && !inv.d1.includes(names.databaseName)) {
    errors.push(
      `No existe la base D1 "${names.databaseName}" que pide wrangler.toml. ` +
        `Créala: wrangler d1 create ${names.databaseName}`,
    );
  }

  if (inv.vectorize && names.indexName) {
    const found = inv.vectorize.find((i) => i.name === names.indexName);
    if (!found) {
      errors.push(
        `No existe el índice Vectorize "${names.indexName}" que pide wrangler.toml. ` +
          `Créalo: wrangler vectorize create ${names.indexName} --dimensions=${KB_DIMENSIONS} --metric=cosine`,
      );
    } else if (found.dimensions !== undefined && found.dimensions !== KB_DIMENSIONS) {
      errors.push(
        `El índice "${names.indexName}" tiene ${found.dimensions} dimensiones y el bot embebe con ${KB_DIMENSIONS} ` +
          `(@cf/baai/bge-m3). Así el deploy pasa pero la búsqueda no encuentra nada nunca. ` +
          `Bórralo y recréalo: wrangler vectorize delete ${names.indexName} && ` +
          `wrangler vectorize create ${names.indexName} --dimensions=${KB_DIMENSIONS} --metric=cosine`,
      );
    }
  }

  if (inv.r2 && names.bucketName && !inv.r2.includes(names.bucketName)) {
    errors.push(
      `No existe el bucket R2 "${names.bucketName}" que pide wrangler.toml. ` +
        `Créalo: wrangler r2 bucket create ${names.bucketName}`,
    );
  }

  if (!inv.d1 && !inv.vectorize && !inv.r2) {
    warnings.push(
      "No se pudo consultar Cloudflare (¿sin red o sin `wrangler login`?), así que no se comprobó " +
        "que la base, el índice y el bucket existan. El deploy dirá la verdad.",
    );
  }

  return { errors, warnings };
}

// Run as a script: read from process.env and exit non-zero on failure.
// Guarded so importing this module in tests does not call process.exit.
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };
const isMain =
  typeof process !== "undefined" &&
  typeof (process as any).argv !== "undefined" &&
  /deploy-check\.ts$/.test(String((process as any).argv?.[1] ?? ""));

if (isMain) {
  // El check corre en la MÁQUINA DEL MIEMBRO, donde process.env está vacío: la
  // verdad vive en wrangler.toml ([vars] estampadas por el CLI) y en los SECRETS
  // remotos de Cloudflare. Además, el flujo documentado conecta canales DESPUÉS
  // del primer deploy (FASE 3) y la llave de IA puede ponerse desde el panel —
  // así que canal/llave son AVISOS, no errores que bloqueen.
  const cfg: DeployConfig = { ...process.env };

  let tomlRaw = "";
  try {
    const { readFileSync } = await import("node:fs");
    tomlRaw = readFileSync("wrangler.toml", "utf8");
    for (const k of ["BOT_NAME", "BOT_TIER"] as const) {
      if (!cfg[k]) cfg[k] = tomlRaw.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
    }
  } catch { /* sin wrangler.toml: lo reportará el error de BOT_TIER */ }

  try {
    const { execFileSync } = await import("node:child_process");
    const raw = execFileSync("npx", ["wrangler", "secret", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const s of JSON.parse(raw.slice(raw.indexOf("["))) as { name: string }[]) {
      if (!cfg[s.name]) cfg[s.name] = "(remote)";
    }
  } catch { /* sin red o sin login: seguimos solo con lo local */ }

  const errors: string[] = [];
  const warnings: string[] = [];
  if (!cfg.BOT_NAME) errors.push("Falta BOT_NAME en wrangler.toml.");
  if (!cfg.BOT_TIER) errors.push("Falta BOT_TIER ('free' | 'pro') en wrangler.toml.");
  if (!cfg.DASHBOARD_PASSWORD) errors.push("Falta el secret DASHBOARD_PASSWORD (créalo: pnpm exec wrangler secret put DASHBOARD_PASSWORD).");
  if (!cfg.ANTHROPIC_API_KEY && !cfg.OPENAI_API_KEY && !cfg.XAI_API_KEY) {
    warnings.push("Aún no hay llave de IA como secret — el bot desplegará pero no contestará. Ponla con `wrangler secret put ANTHROPIC_API_KEY` (o desde el panel: Configuración → Modelo de IA).");
  }
  if (!cfg.TELEGRAM_BOT_TOKEN && !cfg.MANYCHAT_API_KEY && !cfg.TWILIO_ACCOUNT_SID && !cfg.META_PAGE_ACCESS_TOKEN) {
    warnings.push("Aún no hay canales conectados — normal antes de la FASE 3 (se conectan con el panel abierto en /admin/conexiones).");
  }

  // Recursos. Cada lista va en su propio try: que R2 no se pueda consultar no
  // debe cegar la comprobación de D1 y Vectorize. Lo que no se pudo mirar entra
  // como `null`, y `checkResources` no lo convierte en error.
  if (tomlRaw) {
    const { execFileSync } = await import("node:child_process");
    const wrangler = (args: string[]): string =>
      execFileSync("npx", ["wrangler", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    /** El primer '[' o '{' — wrangler antepone banners que no son JSON. */
    const json = (raw: string): unknown => {
      const at = raw.search(/[[{]/);
      if (at < 0) throw new Error("sin JSON");
      return JSON.parse(raw.slice(at));
    };

    const inv: ResourceInventory = { d1: null, vectorize: null, r2: null };
    try {
      inv.d1 = (json(wrangler(["d1", "list", "--json"])) as { name: string }[]).map((d) => d.name);
    } catch { /* sin red / sin login / formato nuevo: se queda en null */ }
    try {
      inv.vectorize = (
        json(wrangler(["vectorize", "list", "--json"])) as {
          name: string;
          config?: { dimensions?: number };
          dimensions?: number;
        }[]
      ).map((i) => ({ name: i.name, dimensions: i.config?.dimensions ?? i.dimensions }));
    } catch { /* idem */ }
    try {
      // `r2 bucket list` no tiene --json, así que se busca el nombre en el texto.
      // Los nombres llevan uid (panaclaw-catalog-<giro>-<uid>), así que un
      // choque por casualidad no es realista.
      const raw = wrangler(["r2", "bucket", "list"]);
      const wanted = parseResourceNames(tomlRaw).bucketName;
      if (wanted) {
        inv.r2 = new RegExp(`(^|\\s|"|')${wanted}(\\s|"|'|$)`, "m").test(raw) ? [wanted] : [];
      }
    } catch { /* idem */ }

    const res = checkResources(parseResourceNames(tomlRaw), inv);
    errors.push(...res.errors);
    warnings.push(...res.warnings);
  }

  if (warnings.length) console.warn("⚠️  Avisos:\n - " + warnings.join("\n - "));
  if (errors.length) {
    console.error("❌ Config incompleta para deploy:\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log("✅ Config de deploy OK." + (warnings.length ? " (con avisos)" : ""));
}
