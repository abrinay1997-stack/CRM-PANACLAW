/**
 * PRIVACY.md → src/privacy-content.generated.ts
 *
 * El Worker no puede leer archivos del disco en runtime, y ni wrangler ni vitest
 * importan Markdown igual. Congelar el texto en un módulo TS es lo único que
 * funciona idéntico en los dos, sin reglas de bundler ni sintaxis de vite.
 *
 * PRIVACY.md sigue siendo la ÚNICA fuente que se edita a mano. El módulo
 * generado se commitea (para que el repo despliegue sin recordar este paso) y se
 * regenera en cada `pnpm run deploy` vía predeploy. Un test verifica que no se
 * hayan desincronizado.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SOURCE = path.join(ROOT, "PRIVACY.md");
const TARGET = path.join(ROOT, "src", "privacy-content.generated.ts");

export function renderModule(markdown: string): string {
  // JSON.stringify escapa comillas, backslashes y saltos de línea de una vez, y
  // deja una cadena que TypeScript acepta tal cual.
  return `// GENERADO por scripts/build-privacy.ts — NO editar a mano.
// Se edita PRIVACY.md y se regenera con: pnpm privacy:build
export const PRIVACY_MARKDOWN = ${JSON.stringify(markdown)};
`;
}

export function build(): void {
  const markdown = fs.readFileSync(SOURCE, "utf8");
  const next = renderModule(markdown);
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
  if (current === next) {
    console.log("privacidad: el módulo ya estaba al día.");
    return;
  }
  fs.writeFileSync(TARGET, next);
  console.log(`privacidad: regenerado desde PRIVACY.md (${markdown.length} caracteres).`);
}

// Solo corre al invocarlo como script; importarlo desde un test no debe escribir.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  build();
}
