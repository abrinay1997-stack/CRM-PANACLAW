/**
 * Conversiones para Meta Ads (1-nov-2026): avisarle a Meta quién de los que
 * llegaron por un anuncio de WhatsApp se volvió lead y quién compró.
 * D1 real (miniflare); la red de Meta, de mentira.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { avisarAMeta, guardarClic, clicDe, estadoMeta, VENTANA_DE_ATRIBUCION_MS } from "../../src/meta/conversiones";

let env: any;
let llamadas: { url: string; init?: RequestInit }[];
let originalFetch: typeof globalThis.fetch;
const CONV = "whatsapp:50760000000";

function redDeMeta(opts: { dataset?: unknown; alta?: unknown; eventos?: unknown; statusEventos?: number } = {}) {
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, init });
    if (u.endsWith("/dataset") && (init?.method ?? "GET") === "GET") return Response.json(opts.dataset ?? { data: [{ dataset_id: "DS1" }] });
    if (u.endsWith("/dataset")) return Response.json(opts.alta ?? { id: "DS-NUEVO" });
    return Response.json(opts.eventos ?? { events_received: 1 }, { status: opts.statusEventos ?? 200 });
  }) as any;
}

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, WHATSAPP_ACCESS_TOKEN: "tok" };
  await new ConversationsRepo(new Db(d1)).getOrCreate("whatsapp", "50760000000", "Cliente");
  originalFetch = globalThis.fetch;
  llamadas = [];
  redDeMeta();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const cuerpo = (i: number) => JSON.parse(String(llamadas[i].init?.body));

describe("el clic del anuncio", () => {
  it("se guarda en la conversación, y la cuenta de WhatsApp Business en el panel", async () => {
    await guardarClic(env, CONV, { ctwaClid: "CLID-1", sourceId: "AD9", wabaId: "WABA7", titular: "Tu página web en 72 horas" });
    const clic = await clicDe(env, CONV);
    expect(clic).toMatchObject({ ctwa_clid: "CLID-1", source_id: "AD9", waba_id: "WABA7" });
    expect(await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.metaWabaId)).toBe("WABA7");
  });

  it("no pisa lo demás que vive en metadata", async () => {
    await env.DB.prepare("UPDATE conversations SET metadata = ? WHERE id = ?").bind(JSON.stringify({ atiende: "panel" }), CONV).run();
    await guardarClic(env, CONV, { ctwaClid: "CLID-1", wabaId: "WABA7" });
    const fila = await env.DB.prepare("SELECT metadata FROM conversations WHERE id = ?").bind(CONV).first();
    expect(JSON.parse(fila.metadata)).toMatchObject({ atiende: "panel", anuncio: { ctwa_clid: "CLID-1" } });
  });
});

describe("avisarAMeta", () => {
  beforeEach(async () => {
    await guardarClic(env, CONV, { ctwaClid: "CLID-1", wabaId: "WABA7" });
  });

  it("LeadSubmitted: busca el conjunto de datos y manda el clic, sin datos del cliente", async () => {
    const r = await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(r.estado).toBe("enviado");
    expect(llamadas[0].url).toBe("https://graph.facebook.com/v26.0/WABA7/dataset");
    expect(llamadas[1].url).toBe("https://graph.facebook.com/v26.0/DS1/events");
    const [evento] = cuerpo(1).data;
    expect(evento).toMatchObject({
      event_name: "LeadSubmitted",
      event_id: "CLID-1:LeadSubmitted",
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { whatsapp_business_account_id: "WABA7", ctwa_clid: "CLID-1" },
    });
    expect(evento.custom_data).toBeUndefined();
    expect(JSON.stringify(cuerpo(1))).not.toContain("50760000000");
    expect(await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.metaDatasetId)).toBe("DS1");
  });

  it("una sola vez por conversación", async () => {
    await avisarAMeta(env, CONV, "LeadSubmitted");
    const r = await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(r).toMatchObject({ estado: "omitido", detalle: "Ya se le había avisado a Meta." });
    expect(llamadas.filter((l) => l.url.endsWith("/events"))).toHaveLength(1);
  });

  it("Purchase va con el monto en dólares; sin monto no sale", async () => {
    expect((await avisarAMeta(env, CONV, "Purchase")).estado).toBe("omitido");
    const r = await avisarAMeta(env, CONV, "Purchase", { valor: 295 });
    expect(r.estado).toBe("enviado");
    const evento = cuerpo(llamadas.length - 1).data[0];
    expect(evento).toMatchObject({ event_name: "Purchase", custom_data: { currency: "USD", value: 295 } });
  });

  it("quien no vino de un anuncio no se le avisa a Meta", async () => {
    await new ConversationsRepo(new Db(env.DB)).getOrCreate("whatsapp", "50761111111", "Otro");
    const r = await avisarAMeta(env, "whatsapp:50761111111", "LeadSubmitted");
    expect(r.estado).toBe("omitido");
    expect(llamadas).toHaveLength(0);
  });

  it("después de 7 días del clic ya no cuenta", async () => {
    await new ConversationsRepo(new Db(env.DB)).getOrCreate("whatsapp", "50762222222", "Viejo");
    await guardarClic(env, "whatsapp:50762222222", { ctwaClid: "CLID-V", wabaId: "WABA7" }, Date.now() - VENTANA_DE_ATRIBUCION_MS - 1000);
    const r = await avisarAMeta(env, "whatsapp:50762222222", "LeadSubmitted");
    expect(r.detalle).toMatch(/más de 7 días/);
    expect(llamadas).toHaveLength(0);
  });

  it("si la cuenta no tiene conjunto de datos, se crea y se guarda", async () => {
    redDeMeta({ dataset: { data: [] } });
    const r = await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(r.estado).toBe("enviado");
    expect(llamadas[1]).toMatchObject({ url: "https://graph.facebook.com/v26.0/WABA7/dataset" });
    expect(llamadas[1].init?.method).toBe("POST");
    expect(llamadas[2].url).toBe("https://graph.facebook.com/v26.0/DS-NUEVO/events");
  });

  it("el conjunto de datos que puso el dueño manda", async () => {
    await new SettingsRepo(new Db(env.DB)).set(SETTING_KEYS.metaDatasetId, "DS-DUENO");
    await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(llamadas.map((l) => l.url)).toEqual(["https://graph.facebook.com/v26.0/DS-DUENO/events"]);
  });

  it("si Meta lo rechaza, queda anotado con el motivo y se puede volver a intentar", async () => {
    redDeMeta({ eventos: { error: { message: "(#100) Missing permission" } }, statusEventos: 400 });
    const r = await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(r).toMatchObject({ estado: "fallo" });
    expect(r.detalle).toContain("Missing permission");
    const estado = await estadoMeta(env);
    expect(estado.fallos30d).toBe(1);
    expect(estado.ultimo?.detalle).toContain("Missing permission");
    redDeMeta();
    expect((await avisarAMeta(env, CONV, "LeadSubmitted")).estado).toBe("enviado");
  });

  it("nunca lanza: un error de red queda como fallo", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("red caída");
    }) as any;
    const r = await avisarAMeta(env, CONV, "LeadSubmitted");
    expect(r).toMatchObject({ estado: "fallo" });
  });

  it("la prueba manda el código de prueba", async () => {
    const clic = (await clicDe(env, CONV))!;
    const r = await avisarAMeta(env, "prueba", "LeadSubmitted", { prueba: { codigo: "TEST123", clic } });
    expect(r.estado).toBe("enviado");
    expect(cuerpo(1).test_event_code).toBe("TEST123");
  });
});
