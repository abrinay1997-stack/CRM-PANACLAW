import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyOwner, handoffNotifyStatus } from "../../src/tools/handoffHuman";
import type { Env } from "../../src/env";

/**
 * Aviso al dueño por correo (Resend).
 *
 * Vive en notifyOwner —no dentro de la tool— para que TODO lo que avisa al
 * dueño mande correo, incluido el watchdog (`src/watchdog.ts`), que antes solo
 * podía avisar por Telegram/WhatsApp aunque el correo estuviera configurado.
 */

const baseEnv = {
  BUSINESS_NAME: "Hugo Hair",
  DASHBOARD_BASE_URL: "https://dash.test",
  RESEND_API_KEY: "re_fake",
  OWNER_EMAIL: "hugo@hugohair.com",
  BOT_TIER: "free",
} as unknown as Env;

const notice = { reason: "reembolso", summary: "María pide su dinero", ticketId: "tkt_1", category: "billing" };

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
});

afterEach(() => vi.restoreAllMocks());

const emailCall = () =>
  fetchSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes("api.resend.com"));

const emailBody = () => JSON.parse(String((emailCall()![1] as RequestInit).body));

describe("notifyOwner — correo", () => {
  it("cuenta el correo como canal de aviso configurado", () => {
    expect(handoffNotifyStatus(baseEnv)).toEqual({ ok: true, channels: ["Email"] });
  });

  it("manda el correo por la API de Resend con el ticket y el link al panel", async () => {
    await notifyOwner(baseEnv, notice);
    const call = emailCall();
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer re_fake",
    });
    const body = emailBody();
    expect(body.to).toEqual(["hugo@hugohair.com"]);
    expect(body.subject).toContain("reembolso");
    expect(body.html).toContain("María pide su dinero");
    expect(body.html).toContain("billing");
    // El link va a la lista de tickets: no existe una ruta /admin/tickets/:id,
    // así que el deep link por ticket que se mandaba antes era un 404.
    expect(body.html).toContain("https://dash.test/admin/tickets");
    expect(body.html).not.toContain("/admin/tickets/tkt_1");
  });

  it("usa onboarding@resend.dev mientras no haya dominio verificado", async () => {
    await notifyOwner(baseEnv, notice);
    expect(emailBody().from).toBe("Hugo Hair Bot <onboarding@resend.dev>");
  });

  it("respeta RESEND_FROM, con o sin nombre", async () => {
    await notifyOwner({ ...baseEnv, RESEND_FROM: "avisos@hugohair.com" } as Env, notice);
    expect(emailBody().from).toBe("Hugo Hair Bot <avisos@hugohair.com>");

    fetchSpy.mockClear();
    await notifyOwner({ ...baseEnv, RESEND_FROM: "Hugo <hola@hugohair.com>" } as Env, notice);
    expect(emailBody().from).toBe("Hugo <hola@hugohair.com>");
  });

  it("escapa el texto del LLM antes de meterlo en el HTML", async () => {
    await notifyOwner(baseEnv, { ...notice, summary: '<img src=x onerror="alert(1)">' });
    expect(emailBody().html).not.toContain("<img");
    expect(emailBody().html).toContain("&lt;img");
  });

  it("deja el motivo en los logs cuando Resend rechaza el correo", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 }),
    );
    await notifyOwner(baseEnv, notice);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("resend 403"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("domain is not verified"));
  });

  it("un correo caído no tumba el aviso de Telegram", async () => {
    const env = { ...baseEnv, TELEGRAM_BOT_TOKEN: "tok", OWNER_TELEGRAM_CHAT_ID: "42" } as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockImplementation(async (url: any) =>
      String(url).includes("api.resend.com")
        ? Promise.reject(new Error("network down"))
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await notifyOwner(env, notice);
    const tg = fetchSpy.mock.calls.find((c: unknown[]) => String(c[0]).includes("api.telegram.org"));
    expect(tg).toBeTruthy();
    expect(JSON.parse(String((tg![1] as RequestInit).body)).chat_id).toBe("42");
  });

  it("sin RESEND_API_KEY no manda correo ni intenta la llamada", async () => {
    await notifyOwner({ ...baseEnv, RESEND_API_KEY: undefined } as Env, notice);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
