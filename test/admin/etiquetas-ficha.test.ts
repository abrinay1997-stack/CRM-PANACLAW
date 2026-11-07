/**
 * Etiquetas de colores y ficha del cliente (7-nov-2026). D'Casa las tiene; en
 * PanaClaw faltaba poder clasificar a mano y ver todo de una persona sin salir del chat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { CustomerFactsRepo } from "../../src/db/facts";
import { crearEtiqueta, leerEtiquetas, alternarEtiqueta, borrarEtiqueta, etiquetasDe } from "../../src/etiquetas";
import { comoNota } from "../../src/notas";
import type { Env } from "../../src/env";

const AUTH = { Authorization: `Basic ${btoa("admin:secret123")}` };
const FORM = { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" };
let env: Env;
let db: Db;
let convs: ConversationsRepo;
let msgs: MessagesRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123", BOT_TIMEZONE: "America/Panama" } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
});

describe("etiquetas", () => {
  it("se crean, no se repiten y se rechaza lo vacío o un color inventado", async () => {
    expect(await crearEtiqueta(db, "Cotizando", "azul")).toBeNull();
    expect(await crearEtiqueta(db, "  cotizando ", "rojo")).toMatch(/Ya existe/);
    expect(await crearEtiqueta(db, "", "azul")).toMatch(/nombre/);
    expect(await crearEtiqueta(db, "X", "fucsia")).toMatch(/color/);
    expect((await leerEtiquetas(db)).map((e) => e.nombre)).toEqual(["Cotizando"]);
  });

  it("ponerla y quitarla en una conversación conserva el resto del metadata", async () => {
    const c = await convs.getOrCreate("whatsapp", "1", "Ana");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify({ sin_seguimiento: true }), c.id]);
    await crearEtiqueta(db, "Pago pendiente", "amarillo");
    const [e] = await leerEtiquetas(db);
    expect(await alternarEtiqueta(db, c.id, e.id)).toBe(true);
    let fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [c.id]);
    expect(etiquetasDe(fila!.metadata)).toEqual([e.id]);
    expect(JSON.parse(fila!.metadata)).toMatchObject({ sin_seguimiento: true });
    expect(await alternarEtiqueta(db, c.id, e.id)).toBe(false);
    fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [c.id]);
    expect(etiquetasDe(fila!.metadata)).toEqual([]);
  });

  it("una etiqueta borrada deja de salir aunque la conversación aún la tenga", async () => {
    const c = await convs.getOrCreate("whatsapp", "2", "Luis");
    await crearEtiqueta(db, "Temporal", "gris");
    const [e] = await leerEtiquetas(db);
    await alternarEtiqueta(db, c.id, e.id);
    await borrarEtiqueta(db, e.id);
    const lista = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(lista).not.toContain("Temporal");
  });

  it("desde el panel: crear (queda puesta), verla en la lista, filtrar y quitarla", async () => {
    const a = await convs.getOrCreate("whatsapp", "3", "Con etiqueta");
    const b = await convs.getOrCreate("whatsapp", "4", "Sin etiqueta");
    await msgs.append(a.id, "user", "hola");
    await msgs.append(b.id, "user", "hola");
    const alta = await adminApp.request("/etiquetas", { method: "POST", headers: FORM, body: new URLSearchParams({ conv: a.id, nombre: "Cotizando", color: "azul" }) }, env);
    expect(await alta.text()).toContain("✓ Cotizando"); // quedó puesta en esta conversación
    const [e] = await leerEtiquetas(db);

    const lista = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(lista).toContain("Cotizando");

    const filtrada = await (await adminApp.request(`/conversations?f=${encodeURIComponent(`etq:${e.id}`)}`, { headers: AUTH }, env)).text();
    expect(filtrada).toContain("Con etiqueta");
    expect(filtrada).not.toContain("Sin etiqueta");

    const quitar = await adminApp.request(`/conversations/${encodeURIComponent(a.id)}/etiqueta/${e.id}`, { method: "POST", headers: AUTH }, env);
    expect(await quitar.text()).not.toContain("✓ Cotizando");
  });

  it("un metadata roto no tumba el filtro", async () => {
    const c = await convs.getOrCreate("whatsapp", "5", "Rota");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", ["{no es json", c.id]);
    const r = await adminApp.request("/conversations?f=etq%3Aloquesea", { headers: AUTH }, env);
    expect(r.status).toBe(200);
  });
});

describe("ficha del cliente", () => {
  it("junta lo que se sabe: contacto, lead, tickets, lo que recuerda el bot y las notas internas", async () => {
    const c = await convs.getOrCreate("whatsapp", "50765085904", "Eladio Ramón");
    await msgs.append(c.id, "user", "Hola, quiero la web\n[ANUNCIO: llegó desde un anuncio de Meta: «Tu página web en 72 horas»]");
    await msgs.append(c.id, "owner", comoNota("pidió factura a nombre de la empresa"));
    await new CustomerFactsRepo(db).addMany(c.id, ["Tiene una ferretería en La Chorrera"]);
    await db.run("INSERT INTO leads (id, conversation_id, name, contact, intent, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", ["l1", c.id, "Eladio Ramón", "6508-5904", "Quiere una web", "contacted", 1, 1]);
    await db.run("INSERT INTO tickets (id, conversation_id, summary, transcript, status, created_at) VALUES (?,?,?,?,?,?)", ["t1", c.id, "Pidió hablar con una persona", "-", "open", 1]);

    const html = await (await adminApp.request(`/conversations/${encodeURIComponent(c.id)}/ficha`, { headers: AUTH }, env)).text();
    expect(html).toContain("Eladio Ramón");
    expect(html).toContain("6508-5904");
    expect(html).toContain("Tu página web en 72 horas");
    expect(html).toContain("Contactado");
    expect(html).toContain("Pidió hablar con una persona");
    expect(html).toContain("Tiene una ferretería en La Chorrera");
    expect(html).toContain("pidió factura a nombre de la empresa");
    expect(html).toContain("Atiende el bot");
  });

  it("escapa lo que escribe la gente: un nombre con HTML no abre la puerta a etiquetas", async () => {
    const c = await convs.getOrCreate("whatsapp", "9", "<img src=x onerror=alert(1)>");
    const html = await (await adminApp.request(`/conversations/${encodeURIComponent(c.id)}/ficha`, { headers: AUTH }, env)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("de una conversación que no existe no devuelve nada", async () => {
    const r = await adminApp.request("/conversations/nope%3A1/ficha", { headers: AUTH }, env);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });

  it("se abre tocando el nombre del chat", async () => {
    const c = await convs.getOrCreate("whatsapp", "11", "Marta");
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(html).toContain(`hx-get="/admin/conversations/${encodeURIComponent(c.id)}/ficha"`);
    expect(html).toContain('hx-target="#ficha"');
  });
});
