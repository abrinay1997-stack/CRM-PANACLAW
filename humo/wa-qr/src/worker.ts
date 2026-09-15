// Prueba de humo del canal WhatsApp por QR — el lado Worker.
//
// No usa `@cloudflare/containers` a propósito: la API cruda de `ctx.container`
// alcanza para esto y así el repo de producción no gana una dependencia por una
// prueba que se va a borrar.
//
// Tres trabajos:
//   1. Servir el QR para escanearlo desde el teléfono.
//   2. Hacer de puente a D1 — el contenedor no tiene bindings, así que guarda
//      sus credenciales llamando aquí por HTTPS con un token.
//   3. Sostener el contenedor prendido con una alarma, y contar los latidos.
//      Ese conteo es el que después se compara contra la factura del DO.

import { DurableObject } from "cloudflare:workers";

export interface Env {
  WA_HUMO: DurableObjectNamespace<WaHumo>;
  DB: D1Database;
  HUMO_BASE_URL: string;
  HUMO_TOKEN: string;
}

const PUERTO_CONTENEDOR = 8080;
const LATIDO_MS = 60_000;

interface Diario {
  arrancadoEn: string;
  latidos: number;
  arranquesContenedor: number;
  ultimoArranque: string | null;
  ultimaMuerteVista: string | null;
  /** Latidos seguidos encontrando el contenedor caído. Gobierna la espera. */
  fallosSeguidos: number;
}

/**
 * Cuánto esperar hasta el próximo latido. Con el contenedor sano, un minuto.
 * Con el contenedor cayéndose, se estira hasta quince.
 *
 * No es una optimización: relevantar cada minuto un contenedor que se cae al
 * arrancar es lo que hizo que Cloudflare dejara de entregar instancias
 * ("There is no container instance that can be provided to this Durable
 * Object"). Insistir más rápido retrasa la recuperación en vez de acelerarla.
 */
function proximoLatido(fallosSeguidos: number): number {
  if (fallosSeguidos === 0) return LATIDO_MS;
  return Math.min(LATIDO_MS * 2 ** fallosSeguidos, 15 * 60_000);
}

export class WaHumo extends DurableObject<Env> {
  /** Proxy hacia el servidor HTTP del contenedor. */
  async fetch(request: Request): Promise<Response> {
    if (!this.ctx.container) {
      return json(500, { error: "Este Worker no tiene contenedor configurado." });
    }
    await this.#asegurarEncendido();

    const url = new URL(request.url);
    const destino = `http://contenedor${url.pathname}${url.search}`;
    const puerto = this.ctx.container.getTcpPort(PUERTO_CONTENEDOR);

    // El contenedor puede estar arrancado pero todavía sin escuchar: `start()`
    // no espera al puerto. Se reintenta en vez de devolver un error que en
    // realidad solo significa "todavía no".
    let ultimoFallo = "";
    for (let intento = 0; intento < 12; intento++) {
      try {
        const respuesta = await puerto.fetch(destino, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        });
        // Respondió: está sano de verdad. `running` se pone en true apenas
        // arranca, antes de escuchar, así que no sirve como señal de salud.
        const diario = await this.#diario();
        if (diario.fallosSeguidos !== 0) {
          diario.fallosSeguidos = 0;
          await this.ctx.storage.put("diario", diario);
        }
        return respuesta;
      } catch (e) {
        ultimoFallo = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return json(503, { error: "El contenedor no respondió a tiempo.", detalle: ultimoFallo });
  }

  /** Mata el contenedor. Es la prueba: al volver, no debe pedir QR nuevo. */
  async matar(): Promise<Diario> {
    const diario = await this.#diario();
    diario.ultimaMuerteVista = new Date().toISOString();
    await this.ctx.storage.put("diario", diario);
    this.ctx.container?.destroy("matado a mano por la prueba de humo");
    return diario;
  }

  async diario(): Promise<Diario> {
    return this.#diario();
  }

  /**
   * El latido. Mantiene vivo al DO —y con él al contenedor— y lo vuelve a
   * levantar si se cayó. Cada disparo se cuenta: 1.440 al día si nunca falla.
   */
  async alarm(): Promise<void> {
    const diario = await this.#diario();
    diario.latidos += 1;

    if (this.ctx.container && !this.ctx.container.running) {
      diario.ultimaMuerteVista = new Date().toISOString();
      diario.fallosSeguidos += 1;
      await this.ctx.storage.put("diario", diario);
      await this.#encender();
    } else {
      diario.fallosSeguidos = 0;
      await this.ctx.storage.put("diario", diario);
    }

    await this.ctx.storage.setAlarm(Date.now() + proximoLatido(diario.fallosSeguidos));
  }

  async #asegurarEncendido(): Promise<void> {
    if (!this.ctx.container!.running) await this.#encender();
    // Si no hay alarma puesta, ponerla. Sin esto el contenedor vive solo
    // mientras alguien esté pidiendo cosas.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + LATIDO_MS);
    }
  }

  async #encender(): Promise<void> {
    const diario = await this.#diario();
    diario.arranquesContenedor += 1;
    diario.ultimoArranque = new Date().toISOString();
    await this.ctx.storage.put("diario", diario);

    this.ctx.container!.start({
      env: {
        PORT: String(PUERTO_CONTENEDOR),
        // El contenedor no tiene bindings: vuelve a entrar por la puerta
        // pública del Worker, con token.
        BRIDGE_URL: this.env.HUMO_BASE_URL,
        BRIDGE_TOKEN: this.env.HUMO_TOKEN,
      },
      // Baileys tiene que salir a wss://web.whatsapp.com.
      enableInternet: true,
    });
  }

  async #diario(): Promise<Diario> {
    const guardado = await this.ctx.storage.get<Diario>("diario");
    if (!guardado) {
      return {
        arrancadoEn: new Date().toISOString(),
        latidos: 0,
        arranquesContenedor: 0,
        ultimoArranque: null,
        ultimaMuerteVista: null,
        fallosSeguidos: 0,
      };
    }
    // El diario que ya está en disco viene de una versión sin `fallosSeguidos`.
    // Sin este ?? 0, el primer `+= 1` daría NaN, `proximoLatido(NaN)` devolvería
    // NaN y `setAlarm(NaN)` dejaría al contenedor sin latido para siempre — un
    // fallo mudo justo en la pieza que existe para recuperarse de fallos.
    return { ...guardado, fallosSeguidos: guardado.fallosSeguidos ?? 0 };
  }
}

// ── El Worker ──────────────────────────────────────────────────────────────

function json(codigo: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo, null, 2), {
    status: codigo,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Cuatro caracteres derivados del token, para comparar sin exponerlo.
 * Mismo algoritmo que en el contenedor: si las huellas coinciden, los dos lados
 * tienen el mismo secreto; si no, el que viaja al contenedor no es el que el
 * Worker valida.
 */
function huella(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 4);
}

/** Un solo contenedor para todo: dos sockets sobre el mismo número se tumban. */
function instancia(env: Env) {
  return env.WA_HUMO.get(env.WA_HUMO.idFromName("unico"));
}

/**
 * De dónde vino el token y cuál era, sin juzgarlo todavía.
 *
 * La vía buena es `cabecera-b64`: el contenedor manda el token en base64 porque
 * una cabecera HTTP no lo entrega intacto si trae algo fuera de ASCII. Node
 * escribe el valor en latin-1 y este runtime lo lee como UTF-8, así que un byte
 * suelto se vuelve el carácter de reemplazo — mismo largo, distinto contenido,
 * y un 401 que no explica nada. Está medido: huella 1im7 de ambos lados y 1mxu
 * en lo que llegaba.
 *
 * `cabecera` en claro se conserva solo para no romper a un cliente viejo, y es
 * justamente la que no se debe usar.
 */
function tokenPresentado(request: Request): {
  via: "cabecera-b64" | "cabecera" | "query" | "nada";
  valor: string;
} {
  const b64 = request.headers.get("x-humo-token-b64");
  if (b64 !== null) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return { via: "cabecera-b64", valor: new TextDecoder().decode(bytes) };
    } catch {
      return { via: "cabecera-b64", valor: "" };
    }
  }
  const deCabecera = request.headers.get("x-humo-token");
  if (deCabecera !== null) return { via: "cabecera", valor: deCabecera };
  const deQuery = new URL(request.url).searchParams.get("t");
  if (deQuery !== null) return { via: "query", valor: deQuery };
  return { via: "nada", valor: "" };
}

function autorizado(request: Request, env: Env): boolean {
  const { valor } = tokenPresentado(request);
  // Comparación de largo fijo: no vale la pena filtrar el token por tiempos.
  if (valor.length !== env.HUMO_TOKEN.length) return false;
  let diferencia = 0;
  for (let i = 0; i < valor.length; i++) {
    diferencia |= valor.charCodeAt(i) ^ env.HUMO_TOKEN.charCodeAt(i);
  }
  return diferencia === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    if (!env.HUMO_TOKEN) {
      return json(500, { error: "Falta el secret HUMO_TOKEN." });
    }
    if (!autorizado(request, env)) {
      // El 401 se explica a sí mismo. Quien llama ya conoce su propio token, así
      // que devolverle su largo y su huella no le revela nada — y es lo que hace
      // que el error del contenedor llegue legible hasta /estado en vez de ser
      // un "401" mudo. Del lado esperado va solo el largo.
      const { via, valor } = tokenPresentado(request);
      return json(401, {
        error: "Token inválido.",
        via,
        presentadoLargo: valor.length,
        presentadoHuella: valor ? huella(valor) : null,
        esperadoLargo: env.HUMO_TOKEN.length,
      });
    }

    // ── El puente a D1 ─────────────────────────────────────────────────────
    // Lo llama el contenedor, no una persona. Es un KV mínimo sobre una tabla.
    if (url.pathname === "/puente/kv") {
      const clave = url.searchParams.get("clave");
      if (!clave) return json(400, { error: "Falta ?clave=" });

      if (request.method === "GET") {
        const fila = await env.DB.prepare("SELECT valor FROM wa_humo_auth WHERE clave = ?")
          .bind(clave)
          .first<{ valor: string }>();
        if (!fila) return new Response("no existe", { status: 404 });
        return new Response(fila.valor, { headers: { "content-type": "application/json" } });
      }

      if (request.method === "PUT") {
        const valor = await request.text();
        await env.DB.prepare(
          `INSERT INTO wa_humo_auth (clave, valor, actualizado_en) VALUES (?, ?, ?)
           ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`,
        )
          .bind(clave, valor, Date.now())
          .run();
        return json(200, { ok: true });
      }

      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM wa_humo_auth WHERE clave = ?").bind(clave).run();
        return json(200, { ok: true });
      }

      return json(405, { error: "método no permitido" });
    }

    const stub = instancia(env);

    // ── Lo que mira una persona ────────────────────────────────────────────

    if (url.pathname === "/estado") {
      const [delContenedor, delDo] = await Promise.all([
        stub
          .fetch(new Request("http://c/estado"))
          .then((r) => r.json())
          .catch((e) => ({ error: String(e) })),
        stub.diario(),
      ]);
      const credenciales = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM wa_humo_auth",
      ).first<{ n: number }>();
      return json(200, {
        contenedor: delContenedor,
        durableObject: delDo,
        filasDeCredencialesEnD1: credenciales?.n ?? 0,
        // Para comparar contra `tokenLargo` y `tokenHuella` del contenedor.
        // Si no coinciden, el secreto no llegó igual a los dos lados.
        tokenDelWorker: {
          largo: env.HUMO_TOKEN.length,
          huella: huella(env.HUMO_TOKEN),
          // Si este número NO coincide con `largo`, el secret guardado trae
          // espacios o un salto de línea al principio o al final. Importa
          // mucho: una cabecera HTTP se entrega recortada, así que el token
          // llegaría más corto que el guardado y daría 401 — mientras que por
          // `?t=` en la URL viaja entero y funciona. Explicaría exactamente lo
          // que estamos viendo.
          largoRecortado: env.HUMO_TOKEN.trim().length,
        },
      });
    }

    if (url.pathname === "/matar" && request.method === "POST") {
      const diario = await stub.matar();
      return json(200, {
        ok: true,
        mensaje:
          "Contenedor matado. El latido lo levanta en menos de un minuto. " +
          "Si al volver el estado queda 'conectada' sin pedir QR, la prueba pasó.",
        diario,
      });
    }

    if (url.pathname === "/logout" && request.method === "POST") {
      return stub.fetch(new Request("http://c/logout", { method: "POST" }));
    }

    if (url.pathname === "/qr" || url.pathname === "/") {
      const datos = (await stub
        .fetch(new Request("http://c/qr"))
        .then((r) => r.json())
        .catch(() => null)) as { qr: string | null; estado: string } | null;
      return new Response(paginaQr(datos, url.searchParams.get("t") ?? ""), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return json(404, { error: "no existe" });
  },
};

/**
 * La página del QR. Se abre desde el teléfono, así que nada de anchos fijos:
 * el §7 del design-system del panel aplica igual aquí aunque esto sea temporal.
 */
function paginaQr(datos: { qr: string | null; estado: string } | null, token: string): string {
  const estado = datos?.estado ?? "sin respuesta";
  const cuerpo = datos?.qr
    ? `<img src="${datos.qr}" alt="Código QR de WhatsApp" style="width:100%;max-width:320px;height:auto;border-radius:12px;background:#fff;padding:12px">
       <p style="margin-top:16px">Abra WhatsApp → <strong>Dispositivos vinculados</strong> → <strong>Vincular dispositivo</strong>.</p>`
    : estado === "conectada"
      ? `<p style="font-size:1.25rem"><strong>Vinculado.</strong></p>
         <p>Ahora la prueba que decide todo: matar el contenedor y ver si vuelve
            solo, sin pedir otro QR. La sesión vive en D1, no en su disco.</p>
         <button id="matar">Matar el contenedor</button>
         <p id="resultado" style="margin-top:12px"></p>
         <p style="font-size:0.875rem;opacity:.75">Tarda hasta un minuto en volver:
            lo relevanta el latido del Durable Object. La página sigue refrescándose sola.</p>`
      : `<p>Esperando a que el contenedor levante…</p>`;

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prueba de humo — WhatsApp por QR</title>
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px 16px; background:#050D1F; color:#E8EEF9;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; }
  .estado { display:inline-block; padding:4px 10px; border-radius:999px;
            background:#12203A; font-size:0.875rem; }
  a { color:#1E90FF; }
  /* 44 px de alto y 16 px de texto: el §7 del design-system del panel aplica
     igual aquí, porque esto se abre desde el teléfono. */
  button { min-height:44px; padding:0 20px; font-size:16px; cursor:pointer;
           border:0; border-radius:10px; background:#F5A623; color:#050D1F;
           font-weight:600; }
  button:disabled { opacity:.5; cursor:default; }
</style></head>
<body><main>
  <h1 style="font-size:1.375rem;margin:0 0 8px">Prueba de humo · WhatsApp por QR</h1>
  <p class="estado">Estado: ${estado}</p>
  <div style="margin-top:20px">${cuerpo}</div>
  <p style="margin-top:28px;font-size:0.875rem;opacity:.75">
    Esta página se refresca sola cada 5 s.
    <a href="/estado?t=${encodeURIComponent(token)}">Ver el estado completo</a>.
  </p>
<script>
// El botón existe porque /matar es un POST y un navegador no lo manda con solo
// abrir la URL. Detiene el refresco automático mientras responde, para que la
// recarga no se lleve el mensaje antes de que alguien lo lea.
(function () {
  var boton = document.getElementById("matar");
  if (!boton) return;
  boton.addEventListener("click", async function () {
    boton.disabled = true;
    boton.textContent = "Matando…";
    var meta = document.querySelector('meta[http-equiv="refresh"]');
    if (meta) meta.remove();
    var salida = document.getElementById("resultado");
    try {
      var r = await fetch("/matar?t=" + encodeURIComponent(${JSON.stringify(token)}), { method: "POST" });
      var j = await r.json();
      salida.textContent = j.mensaje || JSON.stringify(j);
    } catch (e) {
      salida.textContent = "Falló la llamada: " + e.message;
    }
    boton.textContent = "Matado — recargue en un minuto";
  });
})();
</script>
</main></body></html>`;
}
