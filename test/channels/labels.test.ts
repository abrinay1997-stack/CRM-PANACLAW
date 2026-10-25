import { describe, it, expect } from "vitest";
import { configuredChannels, channelLabel } from "../../src/channels/labels";
import type { Env } from "../../src/env";

const env = (over: Partial<Env>) => over as Env;

describe("configuredChannels", () => {
  it("lista WhatsApp oficial cuando están el phone id y el token", () => {
    const out = configuredChannels(
      env({ WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_ACCESS_TOKEN: "tok" }),
    );
    expect(out).toEqual([{ id: "whatsapp", label: "WhatsApp", detail: "Meta oficial" }]);
  });

  // El token sin el phone id (o al revés) no alcanza para recibir ni responder:
  // mostrarlo como conectado mandaría al dueño a buscar el problema al lugar
  // equivocado.
  it("no lo lista si falta una de las dos piezas", () => {
    expect(configuredChannels(env({ WHATSAPP_PHONE_NUMBER_ID: "123" }))).toEqual([]);
    expect(configuredChannels(env({ WHATSAPP_ACCESS_TOKEN: "tok" }))).toEqual([]);
  });

  it("distingue WhatsApp oficial de WhatsApp por Twilio cuando conviven", () => {
    const out = configuredChannels(
      env({
        WHATSAPP_PHONE_NUMBER_ID: "123",
        WHATSAPP_ACCESS_TOKEN: "tok",
        TWILIO_ACCOUNT_SID: "AC123",
      }),
    );
    expect(out.map((c) => c.detail)).toEqual(["Meta oficial", "Twilio"]);
  });

  it("sin credenciales no inventa canales", () => {
    expect(configuredChannels(env({}))).toEqual([]);
  });
});

describe("channelLabel", () => {
  it("traduce el canal oficial de WhatsApp", () => {
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("twilio")).toBe("WhatsApp");
  });

  it("deja pasar un canal desconocido tal cual, y '—' si no hay", () => {
    expect(channelLabel("otro")).toBe("otro");
    expect(channelLabel(null)).toBe("—");
  });
});

describe("telefonoDelCliente", () => {
  it("en WhatsApp el chat es el número", async () => {
    const { telefonoDelCliente } = await import("../../src/channels/labels");
    expect(telefonoDelCliente("whatsapp", "50765310721")).toBe("+50765310721");
    expect(telefonoDelCliente("twilio", "+50765310721")).toBe("+50765310721");
    expect(telefonoDelCliente("whatsapp-qr", "50765310721@s.whatsapp.net")).toBe("+50765310721");
    expect(telefonoDelCliente("whatsapp-qr", "50765310721:3@s.whatsapp.net")).toBe("+50765310721");
  });

  it("no inventa un número donde el canal no lo da", async () => {
    const { telefonoDelCliente } = await import("../../src/channels/labels");
    expect(telefonoDelCliente("whatsapp-qr", "123456789012345@lid")).toBeNull();
    expect(telefonoDelCliente("telegram", "987654321")).toBeNull();
    expect(telefonoDelCliente("instagram", "17841400000000000")).toBeNull();
  });
});
