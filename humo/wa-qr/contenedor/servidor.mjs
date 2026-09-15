// Prueba de humo: Baileys dentro de un contenedor de Cloudflare.
//
// Es el mismo Baileys que corre en BukoFlow sobre Railway. La ÚNICA diferencia
// —y es la que se está probando— es dónde viven las credenciales: aquí no tocan
// el disco, porque el disco del contenedor es descartable. Van a D1 a través del
// Worker, que hace de puente.
//
// Lo que este servidor tiene que demostrar:
//   1. Que Baileys levanta y emite un QR escaneable.
//   2. Que tras vincular, MATAR el contenedor y volverlo a levantar reconecta
//      solo, sin pedir un QR nuevo. Eso es lo que hace viable todo el canal.

import http from "node:http";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";

const PUERTO = Number(process.env.PORT || 8080);
const PUENTE = process.env.BRIDGE_URL;
const TOKEN = process.env.BRIDGE_TOKEN;
const SILENCIO = pino({ level: "silent" });

if (!PUENTE || !TOKEN) {
  console.error("Faltan BRIDGE_URL o BRIDGE_TOKEN — el contenedor no puede guardar credenciales.");
  process.exit(1);
}

// ── Estado observable ──────────────────────────────────────────────────────
// Lo que el Worker expone en /estado. `reconexiones` y `arrancadoEn` son los
// números que contestan la pregunta de si esto se sostiene solo.

const estado = {
  conexion: "arrancando", // arrancando | esperando-qr | conectada | cerrada
  arrancadoEn: new Date().toISOString(),
  vinculadoComo: null,
  reconexiones: 0,
  ultimoError: null,
  credencialesVenianDeD1: false,
  // Diagnóstico del puente. Nunca el token: solo su largo y su huella, que
  // alcanzan para saber si el que llegó al contenedor es el mismo que tiene el
  // Worker, sin exponer el secreto en una página web.
  puenteUrl: PUENTE,
  tokenLargo: TOKEN.length,
  tokenHuella: huella(TOKEN),
};

/** Cuatro caracteres derivados del token. Sirve para comparar, no para usar. */
function huella(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).slice(0, 4);
}

let qrActual = null; // data URI del QR vigente, o null si ya no hace falta

// ── Que un error no mate el proceso ────────────────────────────────────────
//
// Esto no es cosmético: fue el fallo que convirtió un 401 recuperable en un
// ciclo de caídas. `socket.ev.on("creds.update", saveCreds)` entrega una
// promesa que nadie atrapa; cuando el puente devolvía 401, esa promesa quedaba
// rechazada sin capturar y Node 22 mata el proceso. El contenedor moría, la
// alarma lo relevantaba, volvía a morir — hasta que Cloudflare dejó de
// entregar instancias ("There is no container instance that can be provided").
//
// Un contenedor que se cae no deja ver POR QUÉ se cayó. Vale mucho más que siga
// en pie reportando su error que que muera limpio.

process.on("unhandledRejection", (e) => {
  estado.ultimoError = `promesa sin capturar: ${e?.message ?? e}`;
  console.error("unhandledRejection:", e);
});

process.on("uncaughtException", (e) => {
  estado.ultimoError = `excepción sin capturar: ${e?.message ?? e}`;
  console.error("uncaughtException:", e);
});

// ── El puente a D1 ─────────────────────────────────────────────────────────
// Un KV mínimo sobre HTTPS. BufferJSON es de Baileys: sus credenciales llevan
// Buffers y Uint8Arrays que JSON.stringify solo no sabe serializar.

async function puente(ruta, init = {}) {
  const r = await fetch(`${PUENTE}${ruta}`, {
    ...init,
    headers: { ...(init.headers || {}), "x-humo-token": TOKEN },
  });
  return r;
}

/** El cuerpo del error, recortado. El Worker explica ahí por qué rechazó. */
async function porQue(r) {
  try {
    return (await r.text()).replace(/\s+/g, " ").slice(0, 300);
  } catch {
    return "";
  }
}

async function kvGet(clave) {
  const r = await puente(`/puente/kv?clave=${encodeURIComponent(clave)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`kvGet(${clave}) → ${r.status} · ${await porQue(r)}`);
  return JSON.parse(await r.text(), BufferJSON.reviver);
}

async function kvSet(clave, valor) {
  const r = await puente(`/puente/kv?clave=${encodeURIComponent(clave)}`, {
    method: "PUT",
    body: JSON.stringify(valor, BufferJSON.replacer),
  });
  if (!r.ok) throw new Error(`kvSet(${clave}) → ${r.status} · ${await porQue(r)}`);
}

async function kvDel(clave) {
  await puente(`/puente/kv?clave=${encodeURIComponent(clave)}`, { method: "DELETE" });
}

/**
 * El equivalente de `useMultiFileAuthState`, pero contra D1.
 *
 * Baileys guarda dos cosas: `creds` (la identidad del dispositivo vinculado) y
 * un montón de llaves de sesión de Signal. Si `creds` sobrevive, no hay QR nuevo.
 */
async function useD1AuthState() {
  const guardadas = await kvGet("creds");
  const creds = guardadas || initAuthCreds();
  estado.credencialesVenianDeD1 = Boolean(guardadas);

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const salida = {};
          await Promise.all(
            ids.map(async (id) => {
              let valor = await kvGet(`${tipo}-${id}`);
              // Caso especial documentado por Baileys: esta llave tiene que
              // volver como mensaje de protobuf, no como objeto pelado.
              if (tipo === "app-state-sync-key" && valor) {
                valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
              }
              salida[id] = valor;
            }),
          );
          return salida;
        },
        set: async (datos) => {
          const tareas = [];
          for (const tipo in datos) {
            for (const id in datos[tipo]) {
              const valor = datos[tipo][id];
              const clave = `${tipo}-${id}`;
              tareas.push(valor ? kvSet(clave, valor) : kvDel(clave));
            }
          }
          await Promise.all(tareas);
        },
      },
    },
    saveCreds: () => kvSet("creds", creds),
  };
}

// ── El socket ──────────────────────────────────────────────────────────────

let socket = null;
let reconectando = false;

async function conectar() {
  const { state, saveCreds } = await useD1AuthState();
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    logger: SILENCIO,
    browser: ["PanaClaw Humo", "Chrome", "3.0"],
    // Sin historial: en una prueba de humo solo estorba y quema CPU, que es
    // justo la métrica que queremos medir limpia.
    syncFullHistory: false,
  });

  // Con `.catch`: si el puente falla, se anota y se sigue. Sin él, la promesa
  // rechazada mataba el proceso (ver los manejadores de arriba).
  socket.ev.on("creds.update", () => {
    saveCreds().catch((e) => {
      estado.ultimoError = `saveCreds: ${e.message}`;
      console.error("saveCreds falló:", e.message);
    });
  });

  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      estado.conexion = "esperando-qr";
      qrActual = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
      console.log("QR nuevo disponible.");
    }

    if (connection === "open") {
      estado.conexion = "conectada";
      estado.vinculadoComo = socket.user?.id ?? null;
      estado.ultimoError = null;
      qrActual = null; // ya no sirve, y dejarlo servido sería un riesgo
      console.log(`Conectada como ${estado.vinculadoComo}`);
    }

    if (connection === "close") {
      const causa =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : 0;
      estado.conexion = "cerrada";
      estado.ultimoError = `cierre ${causa}`;

      if (causa === DisconnectReason.loggedOut) {
        // El teléfono desvinculó el dispositivo. Las credenciales ya no valen:
        // hay que borrarlas o el próximo arranque reintenta con basura.
        console.log("Sesión cerrada desde el teléfono. Limpiando credenciales.");
        await kvDel("creds").catch(() => {});
        estado.vinculadoComo = null;
      }

      if (!reconectando) {
        reconectando = true;
        estado.reconexiones += 1;
        setTimeout(() => {
          reconectando = false;
          conectar().catch((e) => {
            estado.ultimoError = e.message;
            console.error("Fallo al reconectar:", e.message);
          });
        }, 3000);
      }
    }
  });

  // No se procesan mensajes: esto mide la conexión, no el bot. Pero se cuentan,
  // porque recibir uno es la prueba de que el canal sirve de verdad.
  socket.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    estado.mensajesRecibidos = (estado.mensajesRecibidos || 0) + messages.length;
  });
}

// ── HTTP interno, el que el Worker consulta ────────────────────────────────

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://contenedor");
  const json = (codigo, cuerpo) => {
    res.writeHead(codigo, { "content-type": "application/json" });
    res.end(JSON.stringify(cuerpo));
  };

  if (url.pathname === "/estado") return json(200, estado);
  if (url.pathname === "/qr") return json(200, { qr: qrActual, estado: estado.conexion });

  if (url.pathname === "/logout" && req.method === "POST") {
    try {
      await socket?.logout();
    } catch {}
    await kvDel("creds").catch(() => {});
    return json(200, { ok: true });
  }

  json(404, { error: "no existe" });
});

servidor.listen(PUERTO, () => console.log(`Servidor interno en :${PUERTO}`));

// Arranque con reintentos y espera creciente. Si el puente está caído —o
// contesta 401, como pasó— no sirve de nada reintentar cada segundo: se castiga
// al Worker y no se arregla nada. Se estira hasta un minuto y el proceso SIGUE
// EN PIE, que es lo que permite leer el error desde /estado.
let intentos = 0;

async function arrancarConReintentos() {
  for (;;) {
    try {
      await conectar();
      intentos = 0;
      return;
    } catch (e) {
      intentos += 1;
      estado.ultimoError = `${e.message} (intento ${intentos})`;
      console.error(`No se pudo arrancar (intento ${intentos}):`, e.message);
      const espera = Math.min(2000 * 2 ** (intentos - 1), 60000);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

arrancarConReintentos();
