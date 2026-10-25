import { describe, it, expect, vi } from "vitest";
import { searchKbTool } from "../../src/tools/searchKb";

describe("searchKbTool", () => {
  it("returns top-k chunks with scores", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
      KB: { query: vi.fn(async () => ({ matches: [
        { id: "c1", score: 0.91, metadata: { title: "Embebar wall", content: "Pega <div data-tv-wall>...</div>" } },
        { id: "c2", score: 0.78, metadata: { title: "Generar carrusel", content: "Ir a Distribuir..." } },
      ] })) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "como embebo wall" });
    expect(result.results).toHaveLength(2);
    expect(result.results[0].title).toBe("Embebar wall");
    expect(result.results[0].score).toBe(0.91);
  });

  it("returns empty results when KB throws", async () => {
    const fakeEnv = {
      AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) },
      KB: { query: vi.fn(async () => { throw new Error("boom"); }) },
    } as any;
    const tool = searchKbTool(fakeEnv);
    const execute = tool.execute as (input: { query: string }) => Promise<any>;
    const result = await execute({ query: "x" });
    expect(result.error).toBe("transient");
  });

  // El "score < 0.7 → escala" era una orden al modelo, y bge-m3 puntúa entre
  // 0.5 y 0.7 los párrafos que SÍ contestan: el bot descartaba datos buenos.
  it("no le pide al modelo descartar por score, y trae 8 fragmentos", async () => {
    const query = vi.fn(async () => ({ matches: [] }));
    const tool = searchKbTool({ AI: { run: vi.fn(async () => ({ data: [[0.1]] })) }, KB: { query } } as any);
    expect(tool.description).not.toMatch(/0[.,]\d/);
    expect(tool.description).toMatch(/LEE EL CONTENIDO/);
    await (tool.execute as any)({ query: "precio start" });
    expect(query).toHaveBeenCalledWith(expect.anything(), { topK: 8 });
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
});
