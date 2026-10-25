import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { KbDocsRepo } from "../../src/kb/docs";
import { searchKbTool } from "../../src/tools/searchKb";

let d1: any;
let repo: KbDocsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  repo = new KbDocsRepo(new Db(d1));
});

/** El índice simulado: devuelve estos ids con su score, en ese orden. */
function entorno(matches: { id: string; score: number; metadata?: any }[]) {
  const query = vi.fn(async () => ({ matches }));
  const env = { DB: d1, AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) }, KB: { query } } as any;
  return { env, query };
}

const buscar = async (env: any, query = "precio") => (searchKbTool(env).execute as any)({ query });

describe("searchKbTool", () => {
  it("devuelve los pedazos del panel con su score, en el orden del índice", async () => {
    await repo.upsert({ id: "planes", title: "Planes", content: "El Start cuesta $295." });
    await repo.upsert({ id: "care", title: "Care", content: "Care Base cuesta $35 al mes." });
    const { env } = entorno([
      { id: "dash:care#0", score: 0.91 },
      { id: "dash:planes#0", score: 0.78 },
    ]);
    const { results } = await buscar(env);
    expect(results).toEqual([
      { title: "Care", content: "Care Base cuesta $35 al mes.", score: 0.91 },
      { title: "Planes", content: "El Start cuesta $295.", score: 0.78 },
    ]);
  });

  // 25-oct-2026: una sola fuente, el panel.
  it("el texto sale del panel, no de lo que guardó el índice", async () => {
    await repo.upsert({ id: "contacto", title: "Contacto", content: "WhatsApp +507 6531-0721." });
    const { env } = entorno([
      { id: "dash:contacto#0", score: 0.8, metadata: { title: "Contacto", content: "WhatsApp +1 (940) 604-6565." } },
    ]);
    const { results } = await buscar(env);
    expect(results[0].content).toBe("WhatsApp +507 6531-0721.");
  });

  it("descarta las fichas del repo y los documentos que ya no están en el panel", async () => {
    await repo.upsert({ id: "vivo", title: "Vivo", content: "Esto sí." });
    const { env } = entorno([
      { id: "web-plan-start", score: 0.95, metadata: { title: "Ficha del repo", content: "eBot en 48 horas" } },
      { id: "dash:borrado#0", score: 0.9 },
      { id: "dash:vivo#7", score: 0.85 }, // pedazo que ya no existe: el documento se acortó
      { id: "dash:vivo#0", score: 0.6 },
    ]);
    const { results } = await buscar(env);
    expect(results).toEqual([{ title: "Vivo", content: "Esto sí.", score: 0.6 }]);
  });

  it("no le entrega al modelo un borrador con el hueco sin llenar", async () => {
    await repo.upsert({ id: "borrador", title: "Catálogo", content: "Formatos: [COMPLETA AQUÍ - especificar]." });
    const { env } = entorno([{ id: "dash:borrador#0", score: 0.9 }]);
    expect((await buscar(env)).results).toEqual([]);
  });

  // El "score < 0.7 → escala" era una orden al modelo, y bge-m3 puntúa entre
  // 0.5 y 0.7 los párrafos que SÍ contestan: el bot descartaba datos buenos.
  it("no le pide al modelo descartar por score, y devuelve hasta 8 de 50 candidatos", async () => {
    for (let i = 0; i < 12; i++) await repo.upsert({ id: `d${i}`, title: `D${i}`, content: `Dato ${i}.` });
    const { env, query } = entorno(Array.from({ length: 12 }, (_, i) => ({ id: `dash:d${i}#0`, score: 0.5 })));
    const tool = searchKbTool(env);
    expect(tool.description).not.toMatch(/0[.,]\d/);
    expect(tool.description).toMatch(/LEE EL CONTENIDO/);
    const { results } = await buscar(env, "precio start");
    expect(query).toHaveBeenCalledWith(expect.anything(), { topK: 50 });
    expect(results).toHaveLength(8);
  });

  it("el system prompt tampoco pone un umbral de score", async () => {
    const { renderSystemPrompt } = await import("../../src/system-prompt");
    const prompt = renderSystemPrompt({
      botName: "PanaClaw",
      businessName: "PanaClaw",
      language: "es",
      businessContext: "",
      toolList: ["searchKb"],
    });
    expect(prompt).not.toMatch(/score\s*[≥>]=?\s*0[.,]\d/);
  });

  it("returns a transient error when KB throws", async () => {
    const env = {
      DB: d1,
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
      KB: { query: vi.fn(async () => { throw new Error("boom"); }) },
    } as any;
    const result = await buscar(env, "x");
    expect(result.error).toBe("transient");
  });
});
