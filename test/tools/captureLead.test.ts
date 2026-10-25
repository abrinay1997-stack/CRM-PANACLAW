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

