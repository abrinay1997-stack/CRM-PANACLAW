/**
 * Responder citando un mensaje concreto desde el panel (WhatsApp Cloud), como en
 * WhatsApp: el cliente ve la respuesta pegada al mensaje al que contesta.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("agents", () => ({ Agent: class {} }));

const sendReplyMock = vi.fn();
vi.mock("../../src/replies/sender", () => ({ pickAdapter: () => ({ sendReply: sendReplyMock }) }));

import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { registrarMensajes, esIdDeWhatsApp, citaDe, marcaDeWaid } from "../../src/estadosDeEnvio";
import { whatsappAdapter } from "../../src/channels/whatsapp";
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
  sendReplyMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const ID = "wamid.HBgLNTA3NjUwODU5MDQVAgASGBQzQTA";

describe("el envío por WhatsApp Cloud", () => {
  it("lleva el contexto de la cita solo en el primer trozo", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.NUEVO" }] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "507", chunks: ["uno", "dos"], interChunkDelayMs: 0, citaDe: ID },
      { WHATSAPP_PHONE_NUMBER_ID: "P", WHATSAPP_ACCESS_TOKEN: "t" } as any,
    );
    const cuerpos = f.mock.calls.map((c: any) => JSON.parse(c[1].body));
    expect(cuerpos[0].context).toEqual({ message_id: ID });
    expect(cuerpos[1].context).toBeUndefined();
  });

  it("sin cita no lleva contexto", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await whatsappAdapter.sendReply({ channel: "whatsapp", channelUserId: "507", chunks: ["x"], interChunkDelayMs: 0 }, { WHATSAPP_PHONE_NUMBER_ID: "P", WHATSAPP_ACCESS_TOKEN: "t" } as any);
    expect(JSON.parse((f.mock.calls[0] as any)[1].body).context).toBeUndefined();
  });
});

describe("responder desde el panel", () => {
  it("manda la cita al canal y deja dicho en el hilo a cuál respondió", async () => {
    const c = await convs.getOrCreate("whatsapp", "50765085904", "Eladio");
    await registrarMensajes(env, c.id, [ID], "cliente", "¿Cuánto cuesta el plan Start?", null);
    const r = await adminApp.request(`/conversations/${encodeURIComponent(c.id)}/reply`, { method: "POST", headers: FORM, body: new URLSearchParams({ text: "$295", cita: ID }) }, env);
    expect(r.headers.get("X-Sent")).toBe("1");
    expect(sendReplyMock.mock.calls[0][0].citaDe).toBe(ID);
    const fila = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'owner'", [c.id]);
    expect(citaDe(fila!.content)).toEqual({ de: "cliente", extracto: "¿Cuánto cuesta el plan Start?" });
    const hilo = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(hilo).toContain("¿Cuánto cuesta el plan Start?");
  });

  it("una cita rara no se manda al canal ni se guarda", async () => {
    const c = await convs.getOrCreate("whatsapp", "507", "Ana");
    await adminApp.request(`/conversations/${encodeURIComponent(c.id)}/reply`, { method: "POST", headers: FORM, body: new URLSearchParams({ text: "hola", cita: '"},"x":{' }) }, env);
    expect(sendReplyMock.mock.calls[0][0].citaDe).toBeUndefined();
    const fila = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'owner'", [c.id]);
    expect(fila!.content).not.toContain("CITA");
    expect(esIdDeWhatsApp(ID)).toBe(true);
    expect(esIdDeWhatsApp("wamid.x")).toBe(false);
  });

  it("en otro canal la cita se ignora", async () => {
    const c = await convs.getOrCreate("telegram", "u1", "Tel");
    await adminApp.request(`/conversations/${encodeURIComponent(c.id)}/reply`, { method: "POST", headers: FORM, body: new URLSearchParams({ text: "hola", cita: ID }) }, env);
    expect(sendReplyMock.mock.calls[0][0].citaDe).toBeUndefined();
  });
});

describe("el botón «Responder» del hilo", () => {
  it("sale en los mensajes del cliente (con el último id que escribió) y en los nuestros", async () => {
    const c = await convs.getOrCreate("whatsapp", "50760", "Marta");
    const t0 = Date.now() - 60_000;
    await registrarMensajes(env, c.id, ["wamid.CLIENTE_VIEJO_001"], "cliente", "primero", null, t0);
    await registrarMensajes(env, c.id, ["wamid.CLIENTE_RECIENTE_002"], "cliente", "segundo", null, t0 + 5_000);
    await msgs.append(c.id, "user", "primero\nsegundo", { createdAt: t0 + 6_000 });
    await msgs.append(c.id, "owner", `Claro\n${marcaDeWaid(["wamid.NUESTRO_00000003"])}`, { createdAt: t0 + 9_000 });
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(html).toContain('data-waid="wamid.CLIENTE_RECIENTE_002"');
    expect(html).not.toContain('data-waid="wamid.CLIENTE_VIEJO_001"');
    expect(html).toContain('data-waid="wamid.NUESTRO_00000003"');
    expect(html).toContain("window.citar(this)");
  });

  it("no sale en otros canales ni en mensajes sin id", async () => {
    const t = await convs.getOrCreate("telegram", "u2", "Tel");
    await msgs.append(t.id, "user", "hola");
    expect(await (await adminApp.request(`/conversations/thread/${encodeURIComponent(t.id)}`, { headers: AUTH }, env)).text()).not.toContain("window.citar");
    const w = await convs.getOrCreate("whatsapp", "70", "Viejo");
    await msgs.append(w.id, "user", "mensaje de antes de los ids");
    expect(await (await adminApp.request(`/conversations/thread/${encodeURIComponent(w.id)}`, { headers: AUTH }, env)).text()).not.toContain("window.citar");
  });

  it("el campo de respuesta trae la barra de la cita y el id oculto", async () => {
    const c = await convs.getOrCreate("whatsapp", "80", "Barra");
    const pagina = await (await adminApp.request(`/conversations?c=${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(pagina).toContain('id="cita-barra"');
    expect(pagina).toContain('name="cita"');
    expect(pagina).toContain("window.quitarCita");
  });
});
