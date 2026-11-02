import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
import { MessagesRepo } from "../../src/db/messages";
import { captureLeadTool } from "../../src/tools/captureLead";

let env: any;
let leads: LeadsRepo;
let convId: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  const db = new Db(d1 as any);
  leads = new LeadsRepo(db);
  // The leads table FKs conversation_id -> conversations(id), so we need a real
  // conversation row before the tool can attach a lead to it (same pattern as
  // the green handoffHuman/pauseBot tool tests).
  const conv = await new ConversationsRepo(db).getOrCreate("telegram", "u1");
  convId = conv.id;
  // Lo que escribió el cliente: sin un mensaje suyo, no hay lead.
  await new MessagesRepo(db).append(convId, "user", "Quiero la página para mi barbería");
  env = { DB: d1, BOT_TIER: "pro" };
});

describe("captureLeadTool", () => {
  it("creates lead in D1 even without external service", async () => {
    const tool = captureLeadTool(env, () => convId);
    // AI SDK v6: tool.execute is optional + expects (input, options). Invoke with
    // 2 args and cast the result (same pattern as the repo's green tool tests).
    const result = (await tool.execute!(
      {
        name: "María",
        contact: "+5215512345",
        intent: "Corte + barba 5pm",
      },
      {} as any,
    )) as { leadId: string; message: string };
    expect(result.leadId).toBeTruthy();
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(list[0].intent).toBe("Corte + barba 5pm");
  });

  // 25-oct-2026: el aviso de interesado se callaba si había CUALQUIER aviso en
  // la conversación, y con el de «mensaje nuevo» no iba a llegar nunca. Ahora
  // solo lo calla otro lead de la misma conversación en la última media hora.
  it("avisa al dueño del interesado aunque ya le haya llegado el «mensaje nuevo»", async () => {
    const avisos = await import("../../src/owner/avisos");
    const spy = vi.spyOn(avisos, "avisarAlDueno").mockResolvedValue(true);
    const { anotarAviso } = await import("../../src/owner/acciones");
    await anotarAviso(env, "777", 1, convId, null); // el «💬 Mensaje nuevo» de hace un rato
    const tool = captureLeadTool(env, () => convId);
    await tool.execute!({ name: "Pilar", intent: "Start" }, {} as any);
    expect(spy).toHaveBeenCalledTimes(1);
    // El segundo paso de la misma captura (ahora el correo) no avisa otra vez.
    await tool.execute!({ name: "Pilar", contact: "p@x.test", intent: "Start" }, {} as any);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});


// 31-oct-2026: el bot anotó a Gabriel 8 veces, una por mensaje.
describe("un lead por conversación", () => {
  it("la segunda vez completa el mismo lead y no avisa otra vez al dueño", async () => {
    const avisos = await import("../../src/owner/avisos");
    const spy = vi.spyOn(avisos, "avisarAlDueno").mockResolvedValue(true);
    const tool = captureLeadTool(env, () => convId);
    const a = (await tool.execute!({ name: "Gabriel", intent: "Start" }, {} as any)) as { leadId: string };
    const b = (await tool.execute!(
      { name: "Gabriel Garcia Lopez", contact: "+50769151673", intent: "Start $295" },
      {} as any,
    )) as { leadId: string; message: string };
    expect(b.leadId).toBe(a.leadId);
    expect(b.message).toMatch(/No lo anotes otra vez/);
    const list = await leads.list(10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Gabriel Garcia Lopez", contact: "+50769151673", intent: "Start $295" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("lo que no llega se queda como estaba", async () => {
    const tool = captureLeadTool(env, () => convId);
    await tool.execute!({ name: "Pilar", contact: "p@x.test", intent: "Start" }, {} as any);
    await tool.execute!({ intent: "Start con tienda" }, {} as any);
    const [l] = await leads.list(10);
    expect(l).toMatchObject({ name: "Pilar", contact: "p@x.test", intent: "Start con tienda" });
  });

  it("si el lead ya se vendió o se perdió, uno nuevo sí es otro lead", async () => {
    const tool = captureLeadTool(env, () => convId);
    const a = (await tool.execute!({ name: "Pilar", intent: "Start" }, {} as any)) as { leadId: string };
    await leads.setStatus(a.leadId, "sold");
    const b = (await tool.execute!({ name: "Pilar", intent: "Care" }, {} as any)) as { leadId: string };
    expect(b.leadId).not.toBe(a.leadId);
    expect(await leads.list(10)).toHaveLength(2);
  });
});

// 1-nov-2026: el lead de quien llegó por un anuncio se le avisa a Meta.
describe("captureLead y Meta", () => {
  it("al anotar un lead nuevo de un anuncio, avisa «LeadSubmitted» una sola vez", async () => {
    const conv = await import("../../src/meta/conversiones");
    const spy = vi.spyOn(conv, "avisarAMeta").mockResolvedValue({ estado: "enviado", detalle: "" });
    const tool = captureLeadTool(env, () => convId);
    await tool.execute!({ name: "Pilar", intent: "Start" }, {} as any);
    await tool.execute!({ name: "Pilar", contact: "p@x.test", intent: "Start" }, {} as any);
    // Se manda sin esperar (Meta no frena la respuesta): se le da una vuelta.
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).toHaveBeenCalledTimes(1);
    // Sin comparar env: es un proxy de miniflare que no se deja inspeccionar.
    expect(spy.mock.calls[0].slice(1)).toEqual([convId, "LeadSubmitted"]);
    spy.mockRestore();
  });
});

// Auditoría de Meta Ads (1-nov-2026): entraron como leads un señor que pedía un
// préstamo y un diseñador que buscaba empleo. Con la marca de «no es cliente»
// (src/noCliente.ts), la tool no anota nada, lo diga el modelo o no.
describe("captureLead y quien no es cliente", () => {
  it("no anota a quien no viene a comprar, ni le avisa al dueño ni a Meta", async () => {
    const { decidirNoCliente } = await import("../../src/noCliente");
    const avisos = await import("../../src/owner/avisos");
    const spy = vi.spyOn(avisos, "avisarAlDueno").mockResolvedValue(true);
    const meta = await import("../../src/meta/conversiones");
    const spyMeta = vi.spyOn(meta, "avisarAMeta");
    await env.DB.prepare("UPDATE conversations SET metadata = ? WHERE id = ?")
      .bind(JSON.stringify({ no_cliente: { motivo: "prestamo", at: 1 } }), convId)
      .run();
    const r = (await captureLeadTool(env, () => convId).execute!({ name: "Gabriel", intent: "Préstamo de $2,000" }, {} as any)) as {
      leadId: string | null;
      message: string;
    };
    expect(r.leadId).toBeNull();
    expect(r.message).toMatch(/no viene a comprar \(busca un préstamo\)/);
    expect(await leads.list(10)).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 10));
    expect(spy).not.toHaveBeenCalled();
    expect(spyMeta).not.toHaveBeenCalled();

    // Si el dueño dice que sí es cliente, se anota.
    await decidirNoCliente(new Db(env.DB), convId, true);
    const r2 = (await captureLeadTool(env, () => convId).execute!({ name: "Gabriel", intent: "Start" }, {} as any)) as { leadId: string };
    expect(r2.leadId).toBeTruthy();
    spy.mockRestore();
    spyMeta.mockRestore();
  });

  // Hallazgo de Codex: el modelo podía anotar a quien solo tocó el anuncio.
  it("no anota a quien solo mandó el mensaje automático del anuncio y un saludo", async () => {
    const db = new Db(env.DB);
    const otra = (await new ConversationsRepo(db).getOrCreate("whatsapp", "50769999999")).id;
    const msgs = new MessagesRepo(db);
    await msgs.append(otra, "user", "Hola, vi el anuncio de la página web. Quiero información.\n[ANUNCIO: llegó desde un anuncio de Meta: «Tu web»]");
    await msgs.append(otra, "user", "Buenas tardes");
    const r = (await captureLeadTool(env, () => otra).execute!({ intent: "Start" }, {} as any)) as { leadId: string | null; message: string };
    expect(r.leadId).toBeNull();
    expect(r.message).toMatch(/solo mandó el mensaje automático del anuncio/);
    // Un «ok» a «¿avanzamos?» sí es una respuesta.
    await msgs.append(otra, "user", "ok");
    const r2 = (await captureLeadTool(env, () => otra).execute!({ intent: "Start" }, {} as any)) as { leadId: string | null };
    expect(r2.leadId).toBeTruthy();
  });

  it("la descripción le pide al modelo un negocio o un precio, una fecha o empezar", () => {
    const tool = captureLeadTool(env, () => convId) as unknown as { description: string };
    expect(tool.description).toMatch(/dijo qué negocio tiene o pidió precio, fecha o empezar/);
    expect(tool.description).toMatch(/el mensaje automático del anuncio, un saludo o un «ok» no la vuelven lead/);
  });
});
