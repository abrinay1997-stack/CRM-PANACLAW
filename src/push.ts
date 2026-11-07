// Avisos al teléfono (Web Push). Con el panel instalado como app en la pantalla de
// inicio, iPhone (16.4 o más) y Android dejan que la página mande notificaciones: el
// dueño se entera de un ticket, una persona esperando o un lead sin abrir el panel ni
// depender de Telegram.
//
// Todo vive aquí y en el ajuste de la base (sin migración ni secretos que cargar a
// mano): las claves VAPID se crean solas la primera vez y las suscripciones (una por
// teléfono) se guardan en `push_subs`. El mensaje viaja cifrado de punta a punta
// (RFC 8291); Apple o Google solo ven bytes. Enviar es un extra: si falla, se anota y
// la conversación sigue.

import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { Env } from "./env";
import { Db } from "./db/client";
import { SettingsRepo } from "./db/settings";

export interface Suscripcion {
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
  creada: number;
}

const CLAVE_VAPID = "vapid_keys";
const CLAVE_SUBS = "push_subs";
export const MAX_TELEFONOS = 10;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface ClavesVapid {
  publicKey: string;
  privateKey: string;
}

/** Las claves VAPID de este bot; si no existen, se crean y se guardan. */
export async function clavesVapid(db: Db): Promise<ClavesVapid> {
  const ajustes = new SettingsRepo(db);
  const guardadas = await ajustes.get(CLAVE_VAPID);
  if (guardadas) {
    try {
      const v = JSON.parse(guardadas) as ClavesVapid;
      if (v.publicKey && v.privateKey) return v;
    } catch {
      /* se vuelven a crear */
    }
  }
  const par = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publica = new Uint8Array((await crypto.subtle.exportKey("raw", par.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", par.privateKey)) as { d: string };
  const claves = { publicKey: b64url(publica), privateKey: jwk.d };
  await ajustes.set(CLAVE_VAPID, JSON.stringify(claves));
  return claves;
}

export async function leerSuscripciones(db: Db): Promise<Suscripcion[]> {
  const crudo = await new SettingsRepo(db).get(CLAVE_SUBS);
  if (!crudo) return [];
  try {
    const v = JSON.parse(crudo);
    return Array.isArray(v) ? v.filter(esSuscripcion) : [];
  } catch {
    return [];
  }
}

function esSuscripcion(s: any): s is Suscripcion {
  return !!s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && !!s.keys && typeof s.keys.auth === "string" && typeof s.keys.p256dh === "string";
}

/** Guarda (o reemplaza, si el teléfono ya estaba) una suscripción. Devuelve el motivo si no valió. */
export async function guardarSuscripcion(db: Db, cruda: unknown): Promise<string | null> {
  const s = cruda as Partial<Suscripcion> | null;
  if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || s.endpoint.length > 600) return "La suscripción no es válida.";
  if (!s.keys || typeof s.keys.auth !== "string" || typeof s.keys.p256dh !== "string" || s.keys.auth.length > 64 || s.keys.p256dh.length > 128) {
    return "A la suscripción le faltan las claves.";
  }
  const lista = (await leerSuscripciones(db)).filter((x) => x.endpoint !== s.endpoint);
  lista.push({ endpoint: s.endpoint, expirationTime: typeof s.expirationTime === "number" ? s.expirationTime : null, keys: { auth: s.keys.auth, p256dh: s.keys.p256dh }, creada: Date.now() });
  await new SettingsRepo(db).set(CLAVE_SUBS, JSON.stringify(lista.slice(-MAX_TELEFONOS)));
  return null;
}

export async function quitarSuscripcion(db: Db, endpoint: string): Promise<void> {
  const lista = (await leerSuscripciones(db)).filter((x) => x.endpoint !== endpoint);
  await new SettingsRepo(db).set(CLAVE_SUBS, JSON.stringify(lista));
}

export interface AvisoPush {
  titulo: string;
  cuerpo: string;
  /** Dónde abre al tocarla. */
  url?: string;
  /** Avisos con la misma etiqueta se reemplazan en vez de apilarse. */
  etiqueta?: string;
}

/** Manda el aviso a todos los teléfonos suscritos. Devuelve a cuántos llegó. Nunca lanza. */
export async function enviarPush(env: Env, aviso: AvisoPush): Promise<number> {
  try {
    const db = new Db(env.DB);
    const subs = await leerSuscripciones(db);
    if (!subs.length) return 0;
    const vapid = await clavesVapid(db);
    const base = (env.DASHBOARD_BASE_URL ?? "").replace(/\/$/, "");
    const subject = base.startsWith("https://") ? base : "https://panaclaw.com";
    let llegaron = 0;
    for (const s of subs) {
      try {
        const { headers, method, body } = await buildPushPayload(
          {
            data: { titulo: aviso.titulo.slice(0, 80), cuerpo: aviso.cuerpo.slice(0, 160), url: aviso.url ?? "/admin/conversations", ...(aviso.etiqueta ? { etiqueta: aviso.etiqueta } : {}) },
            options: { ttl: 3600, urgency: "high", ...(aviso.etiqueta ? { topic: aviso.etiqueta.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined } : {}) } as any,
          },
          { endpoint: s.endpoint, expirationTime: s.expirationTime, keys: s.keys },
          { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        );
        const r = await fetch(s.endpoint, { method, headers, body });
        if (r.ok) llegaron++;
        // El teléfono ya no existe (desinstaló la app o quitó el permiso): se borra.
        else if (r.status === 404 || r.status === 410) await quitarSuscripcion(db, s.endpoint);
        else console.warn(`[push] ${r.status} al avisar a un teléfono`);
      } catch (e) {
        console.warn("[push] no se pudo avisar a un teléfono:", e);
      }
    }
    return llegaron;
  } catch (e) {
    console.warn("[push] no se pudo enviar:", e);
    return 0;
  }
}
