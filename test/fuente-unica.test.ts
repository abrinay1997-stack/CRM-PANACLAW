/**
 * Una sola fuente de lo que el bot sabe del negocio: el PANEL.
 *
 * 25-oct-2026, a pedido del dueño: «no quiero que lea información del
 * repositorio por un lado y tenga información por el otro». Hasta ese día el
 * bot mezclaba la Información del negocio del panel con los enlaces de
 * member/config.local.ts y la base de conocimiento con 85 fichas del repo, y se
 * contradecían: el panel daba el WhatsApp de EE. UU. que el repo ya había
 * cambiado, y decía que eBot se entrega en 48 horas cuando el sitio dice 3 a 5
 * días. Estas pruebas fallan si una segunda fuente vuelve a entrar.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../src/db/settings";
import { resolveAgentConfig, contextoDelNegocio } from "../src/settings-loader";
import { contextoSemilla, enlacesDelContexto } from "../src/businessContext";

let env: any;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = { DB: d1, BOT_NAME: "PanaClaw", BUSINESS_NAME: "PanaClaw", BOT_LANGUAGE: "es", BOT_TIER: "pro", BUFFER_SECONDS: "5" };
  repo = new SettingsRepo(new Db(d1 as any));
});

const PANEL = `PanaClaw es una agencia web panameña.
Contacto: WhatsApp +507 6531-0721.

ENLACES (los únicos que se mandan, copiados tal cual):
- Planes y precios: https://panaclaw.com/planes/
- Cotizador (precio en 4 preguntas): https://panaclaw.com/cotizador/`;

describe("la Información del negocio sale solo del panel", () => {
  it("el prompt lleva el texto del panel y nada del archivo del repo", async () => {
    await repo.set(SETTING_KEYS.businessContext, PANEL);
    const cfg = await resolveAgentConfig(env, ["searchKb"]);
    expect(cfg.systemPrompt).toContain("PanaClaw es una agencia web panameña.");
    // Una línea que solo existe en member/config.local.ts.
    expect(cfg.systemPrompt).not.toContain("Capacidades sueltas (cuentas, panel");
  });

  it("los enlaces autorizados salen del texto del panel, no del repo", async () => {
    await repo.set(SETTING_KEYS.businessContext, PANEL);
    const cfg = await resolveAgentConfig(env, ["searchKb"]);
    const bloque = /<enlaces_autorizados>([\s\S]*?)<\/enlaces_autorizados>/.exec(cfg.systemPrompt)?.[1] ?? "";
    expect(bloque).toContain("- Planes y precios: https://panaclaw.com/planes/");
    expect(bloque).toContain("- Cotizador (precio en 4 preguntas): https://panaclaw.com/cotizador/");
    // Está en member/config.local.ts pero no en el panel: para el bot no existe.
    expect(bloque).not.toContain("https://panaclaw.com/seguridad/");
  });

  it("con el panel vacío lo siembra UNA vez con lo del repo, y desde ahí manda el panel", async () => {
    const primera = await contextoDelNegocio(env);
    expect(primera).toBe(contextoSemilla());
    expect(await repo.get(SETTING_KEYS.businessContext)).toBe(contextoSemilla());
    expect(await repo.get(SETTING_KEYS.contextoSembrado)).toBe("1");
    // La semilla trae los enlaces adentro, en el formato que el panel entiende.
    expect(enlacesDelContexto(primera)).toContain("https://panaclaw.com/planes/");

    // El dueño la vacía a propósito: se queda vacía, no vuelve la del repo.
    await repo.set(SETTING_KEYS.businessContext, "");
    expect(await contextoDelNegocio(env)).toBe("");
  });
});

describe("enlacesDelContexto", () => {
  it("lee las líneas «- Nombre: URL», sin repetir y sin la puntuación final", () => {
    const out = enlacesDelContexto(
      "Texto libre con https://no-es-linea.test en medio.\n" +
        "- Planes: https://x.test/planes/\n" +
        "* Ayuda: https://x.test/ayuda/.\n" +
        "Contacto: https://x.test/contacto/\n" +
        "- Repetido: https://x.test/planes/",
    );
    expect(out).toBe("- Planes: https://x.test/planes/\n- Ayuda: https://x.test/ayuda/\n- Contacto: https://x.test/contacto/");
  });

  it("sin enlaces devuelve vacío, para no dejar una sección hueca en el prompt", () => {
    expect(enlacesDelContexto("Abrimos de 9 a 6.")).toBe("");
  });
});

describe("el código del bot no lee conocimiento del repo", () => {
  const archivos = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? archivos(p) : p.endsWith(".ts") ? [p] : [];
    });

  it("solo src/kb/docs.ts importa las fichas del repo (para sembrar y para borrarlas del índice)", () => {
    const usan = archivos("src").filter((f) => readFileSync(f, "utf8").includes("kb-fixtures.json"));
    expect(usan.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/kb/docs.ts"]);
  });

  it("nada de src/ lee member/kb/", () => {
    const usan = archivos("src").filter((f) => /member\/kb\//.test(readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "")));
    expect(usan).toEqual([]);
  });

  it("los datos del negocio del repo solo se usan como semilla", () => {
    const usan = archivos("src").filter((f) => /\b(renderBusinessContext|renderAuthorizedLinks)\(/.test(readFileSync(f, "utf8")));
    expect(usan.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/businessContext.ts"]);
  });
});
