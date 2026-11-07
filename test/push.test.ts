/**
 * Avisos al teléfono (Web Push). Lo importante: que lo que sale del Worker lo pueda
 * descifrar de verdad el teléfono. Aquí el «teléfono» es una clave P-256 y un secreto
 * de autenticación generados en la prueba, y el descifrado sigue el RFC 8291.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("agents", () => ({ Agent: class {} }));

import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { clavesVapid, guardarSuscripcion, leerSuscripciones, quitarSuscripcion, enviarPush, MAX_TELEFONOS } from "../src/push";
import { avisarAlDueno } from "../src/owner/avisos";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";

const AUTH = { Authorization: `Basic ${btoa("admin:secret123")}` };

let env: Env;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = { DB: d1, BOT_TIER: "pro", DASHBOARD_PASSWORD: "secret123", DASHBOARD_BASE_URL: "https://bot.example.workers.dev" } as unknown as Env;
  db = new Db(d1);
});
afterEach(() => vi.restoreAllMocks());

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const concat = (...a: Uint8Array[]) => a.reduce((x, y) => Uint8Array.from([...x, ...y]), new Uint8Array());

/** Un «teléfono»: lo que le daría Safari a la página al suscribirse. */
async function telefono(endpoint = "https://web.push.apple.com/abc123") {
  const par = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publica = new Uint8Array((await crypto.subtle.exportKey("raw", par.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { par, publica, auth, sub: { endpoint, expirationTime: null, keys: { auth: b64url(auth), p256dh: b64url(publica) } } };
}

/** RFC 8291 §3.4: lo que hace el navegador al recibir el aviso. */
async function descifrar(t: Awaited<ReturnType<typeof telefono>>, cuerpo: Uint8Array): Promise<string> {
  const salt = cuerpo.slice(0, 16);
  const idlen = cuerpo[20];
  const keyid = cuerpo.slice(21, 21 + idlen); // la clave pública del servidor
  const cifrado = cuerpo.slice(21 + idlen);
  const servidor = await crypto.subtle.importKey("raw", keyid, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: servidor } as any, t.par.privateKey, 256));
  const hkdf = async (sal: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sal, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bits));
  const enc = new TextEncoder();
  const ikm = await hkdf(t.auth, ecdh, concat(enc.encode("WebPush: info\0"), t.publica, keyid), 256);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const llave = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plano = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, llave, cifrado));
  let fin = plano.length;
  while (fin > 0 && plano[fin - 1] === 0) fin--; // relleno
  return new TextDecoder().decode(plano.slice(0, fin - 1)); // el último byte es el delimitador 0x02
}

describe("claves y suscripciones", () => {
  it("las claves VAPID se crean solas, una vez, y son del tamaño que exige el estándar", async () => {
    const a = await clavesVapid(db);
    const b = await clavesVapid(db);
    expect(b).toEqual(a);
    expect(deB64url(a.publicKey)).toHaveLength(65); // punto P-256 sin comprimir
    expect(deB64url(a.privateKey)).toHaveLength(32);
  });

  it("guarda un teléfono, no lo duplica y respeta el máximo", async () => {
    const t = await telefono();
    expect(await guardarSuscripcion(db, t.sub)).toBeNull();
    expect(await guardarSuscripcion(db, t.sub)).toBeNull();
    expect(await leerSuscripciones(db)).toHaveLength(1);
    for (let i = 0; i < MAX_TELEFONOS + 3; i++) await guardarSuscripcion(db, { ...t.sub, endpoint: `https://push.example/${i}` });
    expect((await leerSuscripciones(db)).length).toBeLessThanOrEqual(MAX_TELEFONOS);
  });

  it("rechaza lo que no es una suscripción: sin https, sin claves o vacía", async () => {
    const t = await telefono();
    expect(await guardarSuscripcion(db, { ...t.sub, endpoint: "http://inseguro.example/x" })).toMatch(/válida/);
    expect(await guardarSuscripcion(db, { endpoint: "https://x.example/y" })).toMatch(/claves/);
    expect(await guardarSuscripcion(db, null)).toMatch(/válida/);
    expect(await leerSuscripciones(db)).toHaveLength(0);
  });
});

describe("enviar el aviso", () => {
  it("llega cifrado y el teléfono lo descifra tal como se mandó", async () => {
    const t = await telefono();
    await guardarSuscripcion(db, t.sub);
    const f = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", f);

    const llegaron = await enviarPush(env, { titulo: "🚨 Ticket · pago", cuerpo: "Ana pidió hablar con una persona", url: "/admin/conversations?c=whatsapp%3A507", etiqueta: "conv-abc" });
    expect(llegaron).toBe(1);

    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://web.push.apple.com/abc123");
    expect(init.headers["content-encoding"]).toBe("aes128gcm");
    expect(init.headers.authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(init.headers.authorization).toContain((await clavesVapid(db)).publicKey);
    expect(init.headers.urgency).toBe("high");

    const plano = JSON.parse(await descifrar(t, init.body));
    expect(plano).toEqual({ titulo: "🚨 Ticket · pago", cuerpo: "Ana pidió hablar con una persona", url: "/admin/conversations?c=whatsapp%3A507", etiqueta: "conv-abc" });
    // Lo que viaja no contiene el texto en claro.
    expect(new TextDecoder().decode(init.body)).not.toContain("Ana pidió");
  });

  it("un teléfono que ya no existe (404/410) se borra; uno que falla no frena a los demás", async () => {
    const vivo = await telefono("https://push.example/vivo");
    const muerto = await telefono("https://push.example/muerto");
    const roto = await telefono("https://push.example/roto");
    for (const t of [muerto, roto, vivo]) await guardarSuscripcion(db, t.sub);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/muerto")) return new Response(null, { status: 410 });
        if (url.endsWith("/roto")) throw new Error("sin red");
        return new Response(null, { status: 201 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await enviarPush(env, { titulo: "t", cuerpo: "c" })).toBe(1);
    expect((await leerSuscripciones(db)).map((s) => s.endpoint).sort()).toEqual(["https://push.example/roto", "https://push.example/vivo"]);
  });

  it("sin teléfonos suscritos no hace nada, y nunca lanza", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await enviarPush(env, { titulo: "t", cuerpo: "c" })).toBe(0);
    expect(f).not.toHaveBeenCalled();
    expect(await enviarPush({ ...env, DB: undefined } as any, { titulo: "t", cuerpo: "c" })).toBe(0);
  });

  it("cada aviso al dueño también sale como notificación, aunque Telegram no esté vinculado", async () => {
    const t = await telefono();
    await guardarSuscripcion(db, t.sub);
    const f = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", f);
    await avisarAlDueno(env, { titulo: "🛍 Nueva interesada", cuerpo: "Quiere una web", conversationId: "whatsapp:507" });
    const llamada = f.mock.calls.find((c: any) => String(c[0]).startsWith("https://web.push.apple.com")) as any;
    expect(llamada).toBeTruthy();
    const plano = JSON.parse(await descifrar(t, llamada[1].body));
    expect(plano.titulo).toBe("🛍 Nueva interesada");
    expect(plano.url).toBe("/admin/conversations?c=whatsapp%3A507");
  });
});

describe("rutas del panel y service worker", () => {
  it("clave pública, alta, prueba y baja", async () => {
    const t = await telefono();
    const clave = (await (await adminApp.request("/push/clave", { headers: AUTH }, env)).json()) as { publicKey: string };
    expect(deB64url(clave.publicKey)).toHaveLength(65);

    const alta = await adminApp.request("/push/suscribir", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(t.sub) }, env);
    expect(alta.status).toBe(200);
    const mala = await adminApp.request("/push/suscribir", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ endpoint: "http://x" }) }, env);
    expect(mala.status).toBe(400);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));
    const prueba = (await (await adminApp.request("/push/probar", { method: "POST", headers: AUTH }, env)).json()) as { ok: boolean; llegaron: number };
    expect(prueba).toEqual({ ok: true, llegaron: 1 });

    await adminApp.request("/push/baja", { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ endpoint: t.sub.endpoint }) }, env);
    expect(await leerSuscripciones(db)).toHaveLength(0);
    await quitarSuscripcion(db, "https://nada"); // idempotente
  });

  it("estas rutas piden sesión", async () => {
    const r = await adminApp.request("/push/clave", {}, env);
    expect(r.status).toBe(302); // a la pantalla de entrada
    expect(r.headers.get("location") ?? "").toContain("login");
  });

  it("el service worker muestra el aviso, abre la conversación al tocarlo y no guarda nada en caché", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain("showNotification");
    expect(sw).toContain('addEventListener("notificationclick"');
    expect(sw).toContain("openWindow");
    expect(sw).not.toContain("caches.");
  });
});
