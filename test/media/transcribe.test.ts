import { describe, it, expect, vi } from "vitest";
import { transcribeAudio, idiomaDeTranscripcion } from "../../src/media/transcribe";

describe("transcribeAudio", () => {
  it("calls Workers AI Whisper with base64 audio + returns text", async () => {
    const calls: any[] = [];
    const fakeEnv: any = {
      AI: {
        run: async (model: string, input: any) => {
          calls.push({ model, input });
          return { text: "hola que tal" };
        },
      },
    };
    // mock global fetch for the audio download
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as any;
    const result = await transcribeAudio("https://x/audio.ogg", fakeEnv);
    expect(result.text).toBe("hola que tal");
    expect(calls[0].model).toBe("@cf/openai/whisper-large-v3-turbo");
    // whisper-large-v3-turbo expects a base64 STRING (per Cloudflare docs), not bytes.
    expect(typeof calls[0].input.audio).toBe("string");
    // bytes [1,2,3] -> base64 "AQID"
    expect(calls[0].input.audio).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

// 27-oct-2026: un «hasta mañana» corto salió como «До маньяна». Whisper
// adivinaba el idioma; ahora se le dice el del negocio.
describe("el idioma de la nota de voz", () => {
  it("le dice a Whisper el idioma del negocio, sin la región", async () => {
    const calls: any[] = [];
    const fakeEnv: any = {
      BOT_LANGUAGE: "es-419",
      AI: { run: async (_m: string, input: any) => (calls.push(input), { text: "hasta mañana" }) },
    };
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as any;
    await transcribeAudio("https://x/audio.ogg", fakeEnv);
    expect(calls[0].language).toBe("es");
  });

  it("sin idioma configurado, deja que Whisper lo detecte", () => {
    expect(idiomaDeTranscripcion(undefined)).toBeNull();
    expect(idiomaDeTranscripcion("")).toBeNull();
    expect(idiomaDeTranscripcion("en")).toBe("en");
    expect(idiomaDeTranscripcion("pt_BR")).toBe("pt");
  });
});
