// Fase 1 de la bandeja (7-nov-2026): lo que antes mentía o se perdía en silencio.
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWhatsAppEvents, whatsappAdapter } from "../src/channels/whatsapp";
import { cuerpoDelMensaje, mensajeParaVer, conversacionEnTexto } from "../src/admin/views/mensajes";
import { comoNota, esNotaInterna, notaParaElModelo, textoDeNota } from "../src/notas";
import { marcaDeFallo, maximoDe, sinMarcasDeAdjunto, VIDEO_MAXIMO } from "../src/media/adjuntos";
import { paraElModelo } from "../src/agent";

vi.mock("agents", () => ({ Agent: class {} }));

const ORIGIN = "https://bot.example.workers.dev";
const env = { WHATSAPP_APP_SECRET: "s3cr3t" } as any;

const cuerpo = (messages: any[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messages, contacts: [] } }] }],
});

afterEach(() => vi.restoreAllMocks());

describe("videos de WhatsApp", () => {
  it("un video entrante ya no se descarta: llega con su URL firmada", async () => {
    const out = await parseWhatsAppEvents(
      cuerpo([{ from: "507600", id: "w1", type: "video", video: { id: "MEDIA9", caption: "mira esto" } }]) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].videoUrl).toMatch(/\/webhooks\/whatsapp\/media\/MEDIA9\?exp=\d+&sig=[a-f0-9]{64}$/);
    expect(out[0].text).toBe("mira esto");
  });

  it("el tope de un video es mayor que el de una foto", () => {
    expect(maximoDe("video")).toBe(VIDEO_MAXIMO);
    expect(maximoDe("video")).toBeGreaterThan(maximoDe("imagen"));
  });
});

describe("el panel dice cuando un archivo no se pudo guardar", () => {
  it("lo explica y dice qué hacer, en vez de callarlo", () => {
    const html = cuerpoDelMensaje(`hola\n${marcaDeFallo("video", "grande")}`, new Map());
    expect(html).toContain("No se pudo guardar el video");
    expect(html).toContain("pesa más de lo que el panel guarda");
    expect(html).not.toContain("antes de que el panel guardara");
    expect(html).not.toContain("ADJUNTO_FALLIDO");
  });

  it("una descarga fallida hoy no se disfraza de «foto vieja»", () => {
    const html = cuerpoDelMensaje(`[IMAGE_URL: https://x/y]\n${marcaDeFallo("imagen", "descarga")}`, new Map());
    expect(html).toContain("no se pudo descargar");
    expect(html).not.toContain("llegó antes de que el panel guardara");
  });

  it("la marca no le llega al modelo ni se cuela en el texto", () => {
    expect(sinMarcasDeAdjunto(`hola\n${marcaDeFallo("audio", "descarga")}`)).toBe("hola");
    expect(paraElModelo(`hola\n${marcaDeFallo("audio", "descarga")}`)).toBe("hola");
    expect(mensajeParaVer(`hola\n${marcaDeFallo("audio", "descarga")}`).texto).toBe("hola");
  });
});

describe("la nota interna", () => {
  it("se marca, se reconoce y se desmarca", () => {
    const n = comoNota("  el cliente prefiere llamada  ");
    expect(esNotaInterna(n)).toBe(true);
    expect(textoDeNota(n)).toBe("el cliente prefiere llamada");
    expect(esNotaInterna("hola, ¿en qué te ayudo?")).toBe(false);
  });

  it("al modelo le llega como contexto del equipo, no como algo que dijo él", () => {
    const m = notaParaElModelo(comoNota("ya le di el precio"));
    expect(m).toContain("Nota interna del equipo");
    expect(m).toContain("no debes mencionarla");
    expect(m).toContain("ya le di el precio");
  });

  it("la exportación la rotula: nadie la confunde con un mensaje enviado", () => {
    const texto = conversacionEnTexto(
      { BOT_TIMEZONE: "America/Panama" } as any,
      { display_name: "Ana", channel: "whatsapp", channel_user_id: "507600" },
      [
        { role: "owner", content: "Te lo mando hoy", created_at: 1 },
        { role: "owner", content: comoNota("revisar pago"), created_at: 2 },
      ],
      new Map(),
    );
    expect(texto).toContain("Equipo: Te lo mando hoy");
    expect(texto).toContain("Nota interna (el cliente no la ve): revisar pago");
  });
});

describe("responder desde el panel por WhatsApp Cloud", () => {
  const reply = { channel: "whatsapp" as const, channelUserId: "507600", chunks: ["hola"], interChunkDelayMs: 0 };
  const envWa = { WHATSAPP_PHONE_NUMBER_ID: "PH", WHATSAPP_ACCESS_TOKEN: "tok" } as any;

  it("si Meta rechaza y se exige entrega, el error sale con el motivo (antes decía «Enviado»)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Re-engagement message: more than 24 hours" } }), { status: 400 })),
    );
    await expect(whatsappAdapter.sendReply({ ...reply, exigirEntrega: true }, envWa)).rejects.toThrow(/24 horas/);
  });

  it("el bot no pide entrega: su turno no se rompe por un envío rechazado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    await expect(whatsappAdapter.sendReply(reply, envWa)).resolves.toBeUndefined();
  });
});
