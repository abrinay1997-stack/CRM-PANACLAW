/**
 * Fase 2B: «entregado/leído», citas y reacciones de WhatsApp Cloud.
 * D1 real vía miniflare.
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
import {
  registrarMensajes,
  registrarEstados,
  estadosDe,
  estadoResumen,
  idsDeWaid,
  marcaDeWaid,
  extractoDe,
  marcaDeCita,
  citaDe,
  reaccionDe,
  motivoDeFallo,
} from "../../src/estadosDeEnvio";
import { prepararEntrante } from "../../src/channels/entrante";
import { parseWhatsAppEvents, whatsappAdapter } from "../../src/channels/whatsapp";
import { mensajeParaVer, cuerpoDelMensaje, marcaDeEntrega } from "../../src/admin/views/mensajes";
import { paraElModelo } from "../../src/agent";
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
  env = { DB: d1, BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123", BOT_TIMEZONE: "America/Panama", WHATSAPP_APP_SECRET: "s" } as unknown as Env;
  db = new Db(d1);
  convs = new ConversationsRepo(db);
  msgs = new MessagesRepo(db);
  sendReplyMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const recibo = (id: string, status: string, errors?: any[]) => ({
  entry: [{ changes: [{ value: { statuses: [{ id, status, errors }] } }] }],
});

describe("marcas", () => {
  it("los ids viajan en el mensaje y se leen de vuelta", () => {
    const c = `Hola\n${marcaDeWaid(["wamid.A=", "wamid.B-"])}`;
    expect(idsDeWaid(c)).toEqual(["wamid.A=", "wamid.B-"]);
    expect(idsDeWaid("sin marca")).toEqual([]);
  });

  it("el extracto no puede romper una marca", () => {
    expect(extractoDe("hola [mundo] | adiós\nlinea 2")).toBe("hola mundo adiós linea 2");
    expect(extractoDe("x".repeat(300)).length).toBe(120);
    const cita = citaDe(marcaDeCita("equipo", "tu cotización [$850]"));
    expect(cita).toEqual({ de: "equipo", extracto: "tu cotización $850" });
  });
});

describe("recibos", () => {
  it("avanzan: enviado → entregado → leído, sin retroceder", async () => {
    await registrarMensajes(env, "whatsapp:1", ["w1"], "equipo", "hola");
    await registrarEstados(env, recibo("w1", "delivered"));
    expect((await estadosDe(env, ["w1"])).get("w1")?.estado).toBe("entregado");
    await registrarEstados(env, recibo("w1", "read"));
    await registrarEstados(env, recibo("w1", "delivered")); // llega tarde
    expect((await estadosDe(env, ["w1"])).get("w1")?.estado).toBe("leido");
  });

  it("un fallo se dice con su motivo en palabras del dueño", async () => {
    await registrarMensajes(env, "whatsapp:1", ["w2"], "bot", "hola");
    await registrarEstados(env, recibo("w2", "failed", [{ code: 131047, title: "Re-engagement message" }]));
    const e = (await estadosDe(env, ["w2"])).get("w2");
    expect(e?.estado).toBe("fallido");
    expect(e?.detalle).toMatch(/24 horas/);
    expect(motivoDeFallo(131026, "x")).toMatch(/no tiene WhatsApp/);
    expect(motivoDeFallo(999, "Algo raro")).toBe("WhatsApp dijo: Algo raro");
  });

  it("los recibos de mensajes que no son nuestros se ignoran", async () => {
    expect(await registrarEstados(env, recibo("desconocido", "read"))).toBe(0);
  });

  it("si un mensaje salió en varios trozos, manda el peor", async () => {
    await registrarMensajes(env, "whatsapp:1", ["a", "b"], "bot", "largo");
    await registrarEstados(env, recibo("a", "read"));
    await registrarEstados(env, recibo("b", "failed", [{ code: 131049 }]));
    const r = estadoResumen(["a", "b"], await estadosDe(env, ["a", "b"]));
    expect(r?.estado).toBe("fallido");
  });

  it("se pinta en el pie del mensaje", () => {
    expect(marcaDeEntrega(null)).toBe("");
    expect(marcaDeEntrega({ estado: "enviado", detalle: null })).toContain("Enviado");
    expect(marcaDeEntrega({ estado: "leido", detalle: null })).toContain("Leído");
    expect(marcaDeEntrega({ estado: "fallido", detalle: "pasaron más de 24 horas" })).toContain("No llegó: pasaron más de 24 horas");
  });

  it("sin la tabla (instalación sin migrar) nada se rompe: se crea sola", async () => {
    // La primera llamada crea la tabla; no hace falta migración.
    expect(await estadosDe(env, ["nada"])).toEqual(new Map());
  });
});

describe("WhatsApp Cloud: ids de lo enviado", () => {
  it("sendReply entrega los ids que dio Meta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.XYZ" }] }), { status: 200 })),
    );
    const ids: string[] = [];
    await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "507", chunks: ["a", "b"], interChunkDelayMs: 0, idsEnviados: ids },
      { WHATSAPP_PHONE_NUMBER_ID: "P", WHATSAPP_ACCESS_TOKEN: "t" } as any,
    );
    expect(ids).toEqual(["wamid.XYZ", "wamid.XYZ"]);
  });

  it("responder desde el panel guarda los ids y el hilo muestra el estado", async () => {
    const c = await convs.getOrCreate("whatsapp", "507700", "Ana");
    sendReplyMock.mockImplementation(async (reply: any) => {
      reply.idsEnviados.push("wamid.P1");
    });
    const res = await adminApp.request(
      `/conversations/${encodeURIComponent(c.id)}/reply`,
      { method: "POST", headers: FORM, body: new URLSearchParams({ text: "Hola Ana" }) },
      env,
    );
    expect(res.headers.get("X-Sent")).toBe("1");
    const fila = await db.first<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'owner'", [c.id]);
    expect(idsDeWaid(fila!.content)).toEqual(["wamid.P1"]);

    await registrarEstados(env, recibo("wamid.P1", "read"));
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(c.id)}`, { headers: AUTH }, env)).text();
    expect(html).toContain("Hola Ana");
    expect(html).toContain("Leído");
    expect(html).not.toContain("WAID");
  });
});

describe("citas", () => {
  const cuerpo = (m: any) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value: { messages: [m], contacts: [] } }] }],
  });

  it("el cliente responde a un mensaje nuestro: se sabe cuál", async () => {
    await registrarMensajes(env, "whatsapp:507", ["wamid.NUESTRO"], "equipo", "El plan Start cuesta $295");
    const [msg] = await parseWhatsAppEvents(
      cuerpo({ from: "507", id: "wamid.SUYO", type: "text", text: { body: "sí, ese" }, context: { id: "wamid.NUESTRO" } }) as any,
      env,
      "https://bot.test",
    );
    expect(msg.citaDe).toBe("wamid.NUESTRO");
    expect(await prepararEntrante(env, msg)).toBe(true);
    expect(msg.text).toBe("sí, ese\n[CITA: equipo | El plan Start cuesta $295]");

    const vista = mensajeParaVer(msg.text!);
    expect(vista.texto).toBe("sí, ese");
    expect(vista.cita).toEqual({ de: "equipo", extracto: "El plan Start cuesta $295" });
    const html = cuerpoDelMensaje(msg.text!, new Map());
    expect(html).toContain("Tú");
    expect(html).toContain("El plan Start cuesta $295");

    // Al modelo le llega en palabras, no como marca.
    const paraModelo = paraElModelo(msg.text!);
    expect(paraModelo).toContain("responde a un mensaje nuestro: «El plan Start cuesta $295»");
    expect(paraModelo).not.toContain("[CITA");
  });

  it("si no conocemos el mensaje citado, lo dice sin inventar", async () => {
    const [msg] = await parseWhatsAppEvents(
      cuerpo({ from: "507", id: "w9", type: "text", text: { body: "ok" }, context: { id: "viejo" } }) as any,
      env,
      "https://bot.test",
    );
    await prepararEntrante(env, msg);
    expect(msg.text).toBe("ok\n[CITA: ? | ]");
    expect(cuerpoDelMensaje(msg.text!, new Map())).toContain("Mensaje anterior");
    expect(paraElModelo(msg.text!)).toContain("responde a un mensaje anterior");
  });

  it("lo que dice el cliente también se puede citar después", async () => {
    const [primero] = await parseWhatsAppEvents(
      cuerpo({ from: "507", id: "wamid.A", type: "text", text: { body: "¿tienen entrega?" } }) as any,
      env,
      "https://bot.test",
    );
    await prepararEntrante(env, primero);
    const [segundo] = await parseWhatsAppEvents(
      cuerpo({ from: "507", id: "wamid.B", type: "text", text: { body: "respondo a lo mío" }, context: { id: "wamid.A" } }) as any,
      env,
      "https://bot.test",
    );
    await prepararEntrante(env, segundo);
    expect(citaDe(segundo.text!)).toEqual({ de: "cliente", extracto: "¿tienen entrega?" });
  });
});

describe("reacciones", () => {
  it("no se contestan, pero quedan en el hilo y cuentan como sin leer", async () => {
    await registrarMensajes(env, "whatsapp:507", ["wamid.OFERTA"], "bot", "Hoy tenemos 2x1");
    const [msg] = await parseWhatsAppEvents(
      { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messages: [{ from: "507", id: "r1", type: "reaction", reaction: { message_id: "wamid.OFERTA", emoji: "👍" } }], contacts: [] } }] }] } as any,
      env,
      "https://bot.test",
    );
    expect(msg.reaccion).toEqual({ emoji: "👍", mensajeId: "wamid.OFERTA" });
    expect(await prepararEntrante(env, msg)).toBe(false); // no va al agente

    const fila = await db.first<{ content: string; role: string }>("SELECT content, role FROM messages WHERE conversation_id = 'whatsapp:507'");
    expect(fila?.role).toBe("user");
    expect(reaccionDe(fila!.content)).toEqual({ emoji: "👍", extracto: "Hoy tenemos 2x1" });
    expect(cuerpoDelMensaje(fila!.content, new Map())).toContain("Reaccionó a «Hoy tenemos 2x1»");
    expect(paraElModelo(fila!.content)).toContain("reaccionó con 👍 a: «Hoy tenemos 2x1»");
  });

  it("quitar la reacción (emoji vacío) no hace nada", async () => {
    const out = await parseWhatsAppEvents(
      { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messages: [{ from: "507", id: "r2", type: "reaction", reaction: { message_id: "x", emoji: "" } }], contacts: [] } }] }] } as any,
      env,
      "https://bot.test",
    );
    expect(out).toHaveLength(0);
  });
});
