/**
 * El panel se puede instalar en la pantalla de inicio. Abierto desde ahí no lleva
 * las barras de Safari, que en el teléfono le quitaban espacio al chat.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { layout } from "../../src/admin/views/layout";

const manifiesto = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));

describe("panel instalable", () => {
  it("el manifiesto pide pantalla completa y arranca en las conversaciones", () => {
    expect(manifiesto.display).toBe("standalone");
    expect(manifiesto.start_url).toBe("/admin/conversations");
    expect(manifiesto.name).toBe("PanaClaw");
    expect(manifiesto.lang).toBe("es");
  });

  it("cada icono que declara existe y es PNG", () => {
    expect(manifiesto.icons.length).toBeGreaterThan(0);
    for (const i of manifiesto.icons as { src: string; type: string }[]) {
      expect(i.type).toBe("image/png");
      const bytes = readFileSync(`public${i.src}`);
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect(statSync(`public${i.src}`).size).toBeGreaterThan(500);
    }
    const tamanos = (manifiesto.icons as { sizes: string }[]).map((i) => i.sizes);
    expect(tamanos).toContain("192x192");
    expect(tamanos).toContain("512x512");
  });

  it("las páginas del panel enlazan el manifiesto y piden abrir sin barras", () => {
    const html = layout({ title: "Prueba", activeTab: "overview", body: "<p>x</p>", env: {} as any });
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="theme-color"');
  });
});

describe("aviso de instalación en todas las pantallas", () => {
  const pagina = (tab: string) => layout({ title: "P", activeTab: tab as any, body: "<p>x</p>", env: {} as any });

  it("sale en cada pantalla del panel, oculto hasta que el script lo decide", () => {
    for (const tab of ["overview", "conversations", "leads", "tickets", "config"]) {
      const html = pagina(tab);
      expect(html).toContain('id="pc-instalar"');
      expect(html).toContain("display:none"); // sin JS no estorba
      expect(html).toContain("Añadir a pantalla de inicio");
    }
  });

  it("no se muestra si ya está instalado como app ni en pantallas grandes, y se puede descartar", () => {
    const html = pagina("overview");
    expect(html).toContain("navigator.standalone");
    expect(html).toContain("display-mode: standalone");
    expect(html).toContain("max-width: 767px");
    expect(html).toContain("pc-instalar-ok");
  });
});
