/**
 * El chat compacto (7-nov-2026): cabecera con menú «⋯», franja de estado, barra
 * de íconos y un campo de una línea con el modo Respuesta / Nota interna.
 * Antes eran ocho botones en tres filas y la caja de respuesta ocupaba media
 * pantalla del teléfono.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import type { Env } from "../../src/env";

const AUTH = { Authorization: `Basic ${btoa("admin:secret123")}` };
let env: Env;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123", BOT_TIMEZONE: "America/Panama", WHATSAPP_PHONE_NUMBER_ID: "P", WHATSAPP_ACCESS_TOKEN: "t" } as unknown as Env;
  const db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
});

describe("chat compacto", () => {
  it("la cabecera cabe en una fila: nombre, canal y un menú «⋯» con lo que se usa poco", async () => {
    const c = await convs.getOrCreate("whatsapp", "50760000000", "Ana Pérez");
    await msgs.append(c.id, "user", "hola");
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(html).toContain('class="hilo-cab"');
    expect(html).toContain("Ana Pérez");
    expect(html).toContain('id="mas"');
    // Lo que antes eran botones sueltos vive en el menú.
    const menu = html.slice(html.indexOf('class="hilo-menu"'));
    expect(menu).toContain("No es cliente");
    expect(menu).toContain("Copiar");
    expect(menu).toContain("Eliminar conversación");
  });

  it("dice quién atiende y ofrece el cambio en un toque", async () => {
    const c = await convs.getOrCreate("whatsapp", "50760000001", "Luis");
    const bot = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(bot).toContain("Atiende el bot");
    expect(bot).toContain("Atender yo");
    await convs.setPausedUntil(c.id, Date.now() + 3_600_000);
    const persona = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(persona).toContain("Atiende una persona");
    expect(persona).toContain("Devolver al bot");
  });

  it("la caja de respuesta: modo Respuesta/Nota, barra de íconos y un solo botón de enviar", async () => {
    const c = await convs.getOrCreate("whatsapp", "50760000002", "Marta");
    const pagina = await (await adminApp.request(`/conversations?c=${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(pagina).toContain('data-modo="respuesta"');
    expect(pagina).toContain('data-modo="nota"');
    expect(pagina).toContain(`data-nota="/admin/conversations/${encodeURIComponent(c.id)}/nota"`);
    expect(pagina).toContain(`data-respuesta="/admin/conversations/${encodeURIComponent(c.id)}/reply"`);
    expect(pagina).toContain('aria-label="Adjuntar archivo"'); // WhatsApp acepta archivos
    expect(pagina).toContain('aria-label="Sugerir una respuesta"');
    expect(pagina).toContain("window.enviarHilo");
    // Ya no hay una fila de botones grandes ni el párrafo de ayuda.
    expect(pagina).not.toContain("Enviar sale al cliente y pausa al bot");
    expect(pagina).not.toContain("Guardar como nota</");
  });

  it("en un canal sin archivos no sale el clip", async () => {
    const c = await convs.getOrCreate("manychat", "u1", "Sin archivos");
    const pagina = await (await adminApp.request(`/conversations?c=${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(pagina).not.toContain('aria-label="Adjuntar archivo"');
    expect(pagina).toContain('aria-label="Respuestas rápidas');
  });

  it("los filtros van en una fila que se desliza, no en cuatro", async () => {
    const pagina = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(pagina).toContain('class="inbox-pills"');
  });
});
