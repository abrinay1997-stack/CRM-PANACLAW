import { describe, it, expect, vi, afterEach } from "vitest";
import { parseWhatsAppEvents, whatsappAdapter, notaDeAnuncio, cortarEnPalabra } from "../../src/channels/whatsapp";

const ORIGIN = "https://bot.example.workers.dev";
const env = { WHATSAPP_APP_SECRET: "s3cr3t" } as any;

function body(messages: any[], extra: any = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "PHONE_ID" },
              contacts: [{ profile: { name: "María" }, wa_id: "5215512345678" }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

describe("parseWhatsAppEvents", () => {
  it("parsea texto", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.1", type: "text", text: { body: "hola" } }]) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].channel).toBe("whatsapp");
    expect(out[0].channelUserId).toBe("5215512345678");
    expect(out[0].text).toBe("hola");
    expect(out[0].displayName).toBe("María");
  });

  it("parsea imagen con caption a una URL de media firmada", async () => {
    const out = await parseWhatsAppEvents(
      body([
        { from: "5215512345678", id: "wamid.2", type: "image", image: { id: "MEDIA_IMG", caption: "ese corte" } },
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("ese corte");
    expect(out[0].imageUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_IMG`);
    expect(out[0].imageUrl).toMatch(/[?&]sig=/);
    expect(out[0].imageUrl).toMatch(/[?&]exp=/);
  });

  it("parsea nota de voz (type audio)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.3", type: "audio", audio: { id: "MEDIA_AUD", voice: true } }]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].audioUrl).toContain(`${ORIGIN}/webhooks/whatsapp/media/MEDIA_AUD`);
    expect(out[0].text).toBeUndefined();
  });

  it("ignora los recibos de entrega/lectura (statuses)", async () => {
    const b = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    };
    const out = await parseWhatsAppEvents(b as any, env, ORIGIN);
    expect(out).toHaveLength(0);
  });

  it("sin App Secret no firma media pero no truena (texto sigue)", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "5215512345678", id: "wamid.4", type: "image", image: { id: "X" } }]) as any,
      {} as any,
      ORIGIN,
    );
    // imagen sin caption y sin URL firmable → se descarta
    expect(out).toHaveLength(0);
  });
});

describe("whatsappAdapter.sendReply", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hace POST al endpoint de Cloud API con el formato correcto", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await whatsappAdapter.sendReply(
      { channel: "whatsapp", channelUserId: "5215512345678", chunks: ["hola"] },
      { WHATSAPP_PHONE_NUMBER_ID: "PHONE_ID", WHATSAPP_ACCESS_TOKEN: "TOKEN" } as any,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    // La versión va explícita a propósito (ver la nota en src/channels/whatsapp.ts).
    // Que este assert falle al subirla es lo deseado: obliga a que el cambio de
    // versión sea una decisión, no un descuido.
    expect(url).toBe("https://graph.facebook.com/v26.0/PHONE_ID/messages");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    const payload = JSON.parse(init.body);
    expect(payload.messaging_product).toBe("whatsapp");
    expect(payload.to).toBe("5215512345678");
    expect(payload.type).toBe("text");
    expect(payload.text.body).toBe("hola");
  });

  it("lanza si falta configuración", async () => {
    await expect(
      whatsappAdapter.sendReply({ channel: "whatsapp", channelUserId: "x", chunks: ["hi"] }, {} as any),
    ).rejects.toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });
});

// PanaClaw paga publicidad: quien toca un anuncio «Clic a WhatsApp» llega con
// `referral`, y hasta el 25-oct-2026 se tiraba.
describe("quien llega desde un anuncio de Meta", () => {
  it("el texto lleva el anuncio que tocó, como marcador", async () => {
    const out = await parseWhatsAppEvents(
      body([
        {
          from: "50760000000",
          id: "wamid.ad",
          type: "text",
          text: { body: "Hola, vi el anuncio. Quiero información." },
          referral: {
            source_type: "ad",
            source_url: "https://fb.me/xyz",
            headline: "Tu página web en 72 horas",
            body: "Desde $295 [y el código es tuyo]",
          },
        },
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe(
      "Hola, vi el anuncio. Quiero información.\n" +
        "[ANUNCIO: llegó desde un anuncio de Meta: «Tu página web en 72 horas» · «Desde $295 y el código es tuyo»]",
    );
  });

  it("sin referral, el texto queda igual", async () => {
    const out = await parseWhatsAppEvents(
      body([{ from: "50760000000", id: "wamid.x", type: "text", text: { body: "hola" } }]) as any,
      env,
      ORIGIN,
    );
    expect(out[0].text).toBe("hola");
  });

  // 27-oct-2026: cortado a los 200 caracteres justos, el anuncio del Start
  // terminaba en «lista en 7».
  it("el texto largo del anuncio se corta en una palabra entera", () => {
    const body =
      "Si vas a abrir tu negocio, tu página web puede estar lista antes que el local. PanaClaw Start: una página de 4 a 5 secciones, " +
      "y los mensajes te llegan directo al WhatsApp. $295, pago único, lista en 72 horas. " +
      "Tú pones tus textos, tus fotos y tu logo; nosotros el diseño, la publicación y que abra en menos de un segundo desde el celular.";
    const nota = notaDeAnuncio({ headline: "Tu página web en 72 horas · $295", body } as any)!;
    expect(nota).toContain("lista en 72 horas");
    expect(nota).toMatch(/…»\]$/);
    expect(cortarEnPalabra("hola mundo", 50)).toBe("hola mundo");
    expect(cortarEnPalabra("lista en 72 horas", 11)).toBe("lista en…");
  });

  it("el anuncio no dispara un aviso al dueño por las palabras que trae", async () => {
    const { detectEscalation } = await import("../../src/escalation-triggers");
    expect(detectEscalation("Hola\n[ANUNCIO: llegó desde un anuncio de Meta: «Cotiza y contrata hoy»]")).toBeNull();
  });
});

// 25-oct-2026: un PDF (factura, comprobante) se ignoraba y nadie se enteraba.
describe("quien manda un documento", () => {
  it("llega como marcador con el enlace firmado y el nombre del archivo", async () => {
    const out = await parseWhatsAppEvents(
      body([
        {
          from: "50760000000",
          id: "wamid.doc",
          type: "document",
          document: { id: "MEDIA_PDF", filename: "factura [oct].pdf", caption: "mi comprobante", mime_type: "application/pdf" },
        },
      ]) as any,
      env,
      ORIGIN,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/^mi comprobante\n\[DOCUMENTO: https:\/\/bot\.example\.workers\.dev\/webhooks\/whatsapp\/media\/MEDIA_PDF\?exp=\d+&sig=[0-9a-f]+ \| factura  oct \.pdf\]$/);
  });

  it("dispara el aviso al dueño, y el ticket dice el nombre del archivo", async () => {
    const { detectEscalation, stripMarkers } = await import("../../src/escalation-triggers");
    const texto = "mi comprobante\n[DOCUMENTO: https://x.test/m?exp=1&sig=a | factura.pdf]";
    expect(detectEscalation(texto)?.label).toBe("mandó un documento");
    expect(stripMarkers(texto)).toBe("mi comprobante\n(documento: factura.pdf)");
    // Por el canal QR llega descrito, sin archivo: también avisa.
    expect(detectEscalation("(el cliente mandó un documento)")?.label).toBe("mandó un documento");
  });
});

