/**
 * 28-oct-2026: el dueño quería ver las fotos y escuchar las notas de voz en el
 * panel (solo las veía en Telegram), ver el teléfono del contacto, copiar o
 * descargar la conversación y exportar los contactos. D1 real (miniflare); R2
 * de mentira, en memoria.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { guardarAdjunto } from "../../src/media/adjuntos";
import { mensajeParaVer, telefonoLegible } from "../../src/admin/views/mensajes";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}` };

function r2EnMemoria() {
  const store = new Map<string, Uint8Array>();
  const borrados: string[] = [];
  return {
    store,
    borrados,
    async put(key: string, v: Uint8Array) {
      store.set(key, new Uint8Array(v));
    },
    async get(key: string, opts?: { range?: Headers }) {
      const b = store.get(key);
      if (!b) return null;
      let range: { offset: number; length: number } | undefined;
      let cuerpo = b;
      const h = opts?.range?.get("range");
      const m = h ? /bytes=(\d+)-(\d*)/.exec(h) : null;
      if (m) {
        const inicio = Number(m[1]);
        const fin = m[2] ? Number(m[2]) : b.length - 1;
        range = { offset: inicio, length: fin - inicio + 1 };
        cuerpo = b.slice(inicio, fin + 1);
      }
      return { size: b.length, range, body: new Response(cuerpo).body };
    },
    async delete(keys: string | string[]) {
      for (const k of ([] as string[]).concat(keys)) {
        borrados.push(k);
        store.delete(k);
      }
    },
  };
}

let env: Env;
let r2: ReturnType<typeof r2EnMemoria>;
const CONV = "whatsapp:50769463706";
let foto: string;
let audio: string;
let pdf: string;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  r2 = r2EnMemoria();
  env = {
    DB: d1,
    CATALOG: r2,
    BOT_NAME: "PanaClaw",
    BUSINESS_NAME: "PanaClaw",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
    BOT_TIMEZONE: "America/Panama",
    BUFFER_SECONDS: "8",
    DASHBOARD_PASSWORD: PASSWORD,
  } as unknown as Env;
  const db = new Db(d1);
  await new ConversationsRepo(db).getOrCreate("whatsapp", "50769463706", "gracielahill23");
  const msgs = new MessagesRepo(db);
  // 0xff 0xd8 0xff: la firma de un JPEG.
  foto = (await guardarAdjunto(env, CONV, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), mime: "application/octet-stream" }, "imagen"))!;
  audio = (await guardarAdjunto(env, CONV, { bytes: new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]), mime: "audio/ogg; codecs=opus" }, "audio"))!;
  pdf = (await guardarAdjunto(env, CONV, { bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" }, "documento", "pago.pdf"))!;
  const t0 = Date.UTC(2026, 9, 27, 1, 37);
  await msgs.append(
    CONV,
    "user",
    "Hola, vi el anuncio.\n[ANUNCIO: llegó desde un anuncio de Meta: «Tu página web en 72 horas · $295» · «Si vas a abrir tu negocio…»]",
    { createdAt: t0 },
  );
  await msgs.append(CONV, "user", `(imagen sin caption)\n[IMAGE_URL: https://bot.test/webhooks/whatsapp/media/1?exp=1&sig=ab]\n[ADJUNTO: ${foto}]`, {
    createdAt: t0 + 60_000,
  });
  await msgs.append(CONV, "user", `hasta mañana\n[ADJUNTO: ${audio}]`, { createdAt: t0 + 120_000 });
  await msgs.append(CONV, "user", `[DOCUMENTO: https://bot.test/webhooks/whatsapp/media/2?exp=1&sig=cd | pago.pdf]\n[ADJUNTO: ${pdf}]`, {
    createdAt: t0 + 180_000,
  });
  await msgs.append(CONV, "assistant", "¡Gracias! Una persona del equipo lo revisa.", { createdAt: t0 + 240_000 });
  // Una foto de antes del 28-oct: el enlace venció y no hay archivo.
  await msgs.append(CONV, "user", "(imagen sin caption)\n[IMAGE_URL: https://bot.test/webhooks/whatsapp/media/0?exp=1&sig=zz]", {
    createdAt: t0 - 60_000,
  });
});

describe("el hilo en el panel", () => {
  it("muestra la foto, el reproductor, el documento y el anuncio, sin las marcas", async () => {
    const res = await adminApp.request(`/conversations/thread/${encodeURIComponent(CONV)}`, { headers: AUTH }, env);
    const html = await res.text();
    expect(html).toContain(`<img src="/admin/adjuntos/${foto}"`);
    expect(html).toContain(`<audio controls preload="metadata" src="/admin/adjuntos/${audio}"`);
    expect(html).toContain("Transcripción");
    expect(html).toContain("pago.pdf");
    expect(html).toContain("Llegó desde el anuncio «Tu página web en 72 horas · $295»");
    expect(html).toContain("Mandó una foto (llegó antes de que el panel guardara las fotos)");
    expect(html).not.toContain("[IMAGE_URL");
    expect(html).not.toContain("[ADJUNTO");
    expect(html).not.toContain("[ANUNCIO");
    expect(html).not.toContain("(imagen sin caption)");
  });

  it("el teléfono del contacto, y copiar y descargar la conversación", async () => {
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(CONV)}`, { headers: AUTH }, env)).text();
    expect(html).toContain("+507 6946-3706");
    expect(html).toContain('aria-label="Copiar la conversación"');
    expect(html).toContain(`/admin/conversations/${encodeURIComponent(CONV)}/texto?descargar=1`);
  });

  it("la hora es la del negocio, no la del servidor", async () => {
    const html = await (await adminApp.request(`/conversations/thread/${encodeURIComponent(CONV)}`, { headers: AUTH }, env)).text();
    // 01:37 UTC del 27-oct = 8:37 p. m. del 26 en Panamá.
    expect(html).toMatch(/26.oct.{0,4}08:37/);
  });

  it("la lista no enseña las marcas en la vista previa", async () => {
    const html = await (await adminApp.request("/conversations", { headers: AUTH }, env)).text();
    expect(html).not.toContain("[IMAGE_URL");
    expect(html).not.toContain("[ADJUNTO");
    expect(html).toContain("/admin/contactos/export.csv");
  });
});

describe("GET /admin/adjuntos/:id", () => {
  it("devuelve el archivo con su tipo de verdad", async () => {
    const res = await adminApp.request(`/adjuntos/${foto}`, { headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
  });

  it("acepta rangos: sin eso Safari no reproduce el audio", async () => {
    const res = await adminApp.request(`/adjuntos/${audio}`, { headers: { ...AUTH, Range: "bytes=2-4" } }, env);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("audio/ogg");
    expect(res.headers.get("content-range")).toBe("bytes 2-4/8");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([12, 13, 14]));
  });

  it("descargar baja el archivo con su nombre", async () => {
    const res = await adminApp.request(`/adjuntos/${pdf}?descargar=1`, { headers: AUTH }, env);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="pago.pdf"/);
  });

  it("un documento que no es foto, audio ni PDF se descarga y no corre nada", async () => {
    const html = (await guardarAdjunto(
      env,
      CONV,
      { bytes: new TextEncoder().encode("<script>fetch('/admin/config')</script>"), mime: "text/html" },
      "documento",
      "factura.html",
    ))!;
    const res = await adminApp.request(`/adjuntos/${html}`, { headers: AUTH }, env);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("una «foto» SVG no se guarda como foto", async () => {
    const svg = (await guardarAdjunto(env, CONV, { bytes: new TextEncoder().encode("<svg onload=alert(1)>"), mime: "image/svg+xml" }, "imagen"))!;
    const res = await adminApp.request(`/adjuntos/${svg}`, { headers: AUTH }, env);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("sin sesión no se ve nada", async () => {
    const res = await adminApp.request(`/adjuntos/${foto}`, {}, env);
    expect(res.status).not.toBe(200);
  });

  it("un id que no existe es 404", async () => {
    expect((await adminApp.request(`/adjuntos/${"f".repeat(32)}`, { headers: AUTH }, env)).status).toBe(404);
    expect((await adminApp.request("/adjuntos/../../x", { headers: AUTH }, env)).status).toBe(404);
  });
});

describe("la conversación en texto", () => {
  it("se descarga con las fotos y audios dichos, sin marcas", async () => {
    const res = await adminApp.request(`/conversations/${encodeURIComponent(CONV)}/texto?descargar=1`, { headers: AUTH }, env);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="conversacion-gracielahill23-\d{4}-\d{2}-\d{2}\.txt"/);
    const t = await res.text();
    expect(t).toContain("Conversación con gracielahill23");
    expect(t).toContain("+507 6946-3706");
    expect(t).toContain("Cliente: (foto)");
    expect(t).toContain("Cliente: (nota de voz) hasta mañana");
    expect(t).toContain("(documento: pago.pdf)");
    expect(t).toContain("(llegó desde el anuncio «Tu página web en 72 horas · $295»)");
    expect(t).toContain("Bot: ¡Gracias!");
    expect(t).not.toMatch(/\[(IMAGE_URL|ADJUNTO|ANUNCIO|DOCUMENTO)/);
  });
});

describe("exportar contactos", () => {
  it("un CSV con todos los que escribieron, su teléfono y si vinieron de un anuncio", async () => {
    const res = await adminApp.request("/contactos/export.csv", { headers: AUTH }, env);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // El BOM de UTF-8, para que Excel no rompa las tildes.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain("nombre,telefono,canal,primer_mensaje,ultimo_mensaje,mensajes_del_cliente,vino_de_un_anuncio");
    expect(csv).toContain('"gracielahill23","+507 6946-3706","WhatsApp"');
    expect(csv).toMatch(/"5","sí"/);
  });
});

describe("borrar la conversación", () => {
  it("se lleva sus fotos, audios y documentos", async () => {
    const res = await adminApp.request(`/conversations/${encodeURIComponent(CONV)}/delete`, { method: "POST", headers: AUTH }, env);
    expect(res.status).toBe(302);
    expect(r2.store.size).toBe(0);
    expect(r2.borrados).toHaveLength(3);
    const quedan = await env.DB.prepare("SELECT COUNT(*) AS n FROM adjuntos").first<{ n: number }>();
    expect(quedan?.n).toBe(0);
  });
});

describe("piezas sueltas", () => {
  it("el mensaje sin marcas", () => {
    const m = mensajeParaVer("hola\n[ADJUNTO: " + "a".repeat(32) + "]\n[ANUNCIO: llegó desde un anuncio de Meta]");
    expect(m.texto).toBe("hola");
    expect(m.adjuntos).toEqual(["a".repeat(32)]);
    expect(m.anuncio).toBe("un anuncio de Meta");
  });

  it("el teléfono panameño, legible", () => {
    expect(telefonoLegible("+50769463706")).toBe("+507 6946-3706");
    expect(telefonoLegible("+573001234567")).toBe("+573001234567");
  });
});
