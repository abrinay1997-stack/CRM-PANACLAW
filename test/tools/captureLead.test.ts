import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { LeadsRepo } from "../../src/db/leads";
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
    expect(spy).toHaveBeenCalledTimes(1);
    // Sin comparar env: es un proxy de miniflare que no se deja inspeccionar.
    expect(spy.mock.calls[0].slice(1)).toEqual([convId, "LeadSubmitted"]);
    spy.mockRestore();
  });
});
