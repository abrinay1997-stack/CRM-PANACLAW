#!/usr/bin/env node
// Despliegue desatendido (Workers Builds / CI), sin terminal interactiva.
//
// El deploy normal (`pnpm run deploy`) dispara `predeploy`, que aborta si aún
// no existe el secret DASHBOARD_PASSWORD. En el PRIMER despliegue ese secret
// todavía no está —se pone después, desde el panel de Cloudflare—, así que ese
// camino no sirve para arrancar. Éste sí: no depende de secrets.
//
// Además resuelve el huevo-y-la-gallina del índice Vectorize: `wrangler deploy`
// valida los bindings y falla si el índice no existe, pero el índice no se
// puede crear desde el MCP de Cloudflare. Aquí se crea (idempotente) justo
// antes de desplegar, leyendo su nombre del wrangler.toml — así el mismo script
// sirve para el bot de cualquier cliente sin editar nada.
//
// Y aplica el esquema de D1 ANTES de desplegar. Sin esto, una actualización que
// agrega una tabla sube el código nuevo contra una base vieja: el panel truena
// y el dueño tiene que abrir una terminal justo cuando creía que todo era
// automático. El esquema es idempotente (CREATE TABLE IF NOT EXISTS / INSERT OR
// IGNORE), así que correrlo en cada push no cuesta nada ni pisa datos.
//
//   node scripts/ci-deploy.mjs
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TOML = "wrangler.toml";
const SCHEMA = "src/db/schema.sql";
const DIMENSIONS = "1024"; // BGE-m3 — debe coincidir con el modelo de src/kb/reindex.ts
const METRIC = "cosine";

if (!existsSync(TOML)) {
  console.error(`✗ No encontré ${TOML}. Corre esto desde la carpeta del bot.`);
  process.exit(1);
}

const toml = readFileSync(TOML, "utf8");

if (toml.includes("{{")) {
  const pending = [...new Set(toml.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])];
  console.error(`✗ ${TOML} todavía tiene marcadores sin resolver: ${pending.join(", ")}`);
  process.exit(1);
}

const indexName = toml.match(/^\s*index_name\s*=\s*["']([^"']+)["']/m)?.[1];
if (!indexName) {
  console.error(`✗ No encontré 'index_name' (bloque [[vectorize]]) en ${TOML}.`);
  process.exit(1);
}

const dbName = toml.match(/^\s*database_name\s*=\s*["']([^"']+)["']/m)?.[1];
if (!dbName) {
  console.error(`✗ No encontré 'database_name' (bloque [[d1_databases]]) en ${TOML}.`);
  process.exit(1);
}

const run = (args) => {
  console.log(`→ wrangler ${args.join(" ")}`);
  return spawnSync("npx", ["wrangler", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
};

// 1 · Índice Vectorize. Volver a crearlo es un error esperado, no un fallo:
// el deploy corre en cada push y el índice solo se crea la primera vez.
console.log(`\n── Índice Vectorize: ${indexName}`);
const vec = run(["vectorize", "create", indexName, `--dimensions=${DIMENSIONS}`, `--metric=${METRIC}`]);
const vecOut = `${vec.stdout ?? ""}${vec.stderr ?? ""}`;
process.stdout.write(vecOut);

if (vec.status !== 0) {
  if (/already exists|duplicate|vectorize\.index\.duplicate/i.test(vecOut)) {
    console.log(`✓ El índice ${indexName} ya existía — seguimos.`);
  } else {
    console.error(`\n✗ No se pudo crear el índice ${indexName}.`);
    process.exit(vec.status ?? 1);
  }
} else {
  console.log(`✓ Índice ${indexName} creado.`);
}

// 2 · Esquema de D1. Idempotente: crea lo que falte y deja intacto lo que ya
// está. Si falla, NO se despliega: es preferible quedarse en la versión que
// funciona que subir código que le pide a la base una tabla que no existe.
console.log(`\n── Esquema de D1: ${dbName}`);
const schema = run(["d1", "execute", dbName, `--file=${SCHEMA}`, "--remote", "--yes"]);
process.stdout.write(`${schema.stdout ?? ""}${schema.stderr ?? ""}`);

if (schema.status !== 0) {
  console.error(`\n✗ No se pudo aplicar el esquema a ${dbName}. No se desplegó nada.`);
  console.error("  Casi siempre es el token del build: necesita permiso de D1 (Edit).");
  console.error("  Salida rápida: corre `pnpm db:apply:remote` una vez desde tu compu");
  console.error("  y vuelve a lanzar el deploy.");
  process.exit(schema.status ?? 1);
}
console.log(`✓ Esquema aplicado en ${dbName}.`);

// 3 · Deploy. `wrangler deploy` directo: sin el hook predeploy que exige secrets.
console.log("\n── Desplegando el Worker");
const dep = spawnSync("npx", ["wrangler", "deploy"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (dep.status !== 0) {
  console.error("\n✗ El deploy falló. Revisa el log de arriba.");
  process.exit(dep.status ?? 1);
}

console.log("\n✓ Listo. El panel vive en <url-del-worker>/admin");
