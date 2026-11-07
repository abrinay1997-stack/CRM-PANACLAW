// Etiquetas de colores puestas a mano por el equipo («cotizando», «pago pendiente»),
// como en D'Casa. Las definiciones viven en el ajuste `etiquetas` y las que tiene cada
// conversación en `conversations.metadata.etiquetas` (sin migración).

import { Db } from "./db/client";
import { SettingsRepo } from "./db/settings";
import { cambiarMetadata } from "./takeover";

export const COLORES: Record<string, string> = {
  verde: "var(--ok)",
  azul: "var(--info)",
  amarillo: "var(--warn)",
  rojo: "var(--bad)",
  violeta: "var(--violet)",
  naranja: "var(--accent-2)",
  gris: "var(--muted)",
};
export const NOMBRES_DE_COLOR = Object.keys(COLORES);

export interface Etiqueta {
  id: string;
  nombre: string;
  /** Una llave de COLORES. */
  color: string;
}

const CLAVE = "etiquetas";
export const MAX_ETIQUETAS = 20;

export async function leerEtiquetas(db: Db): Promise<Etiqueta[]> {
  const crudo = await new SettingsRepo(db).get(CLAVE);
  if (!crudo) return [];
  try {
    const v = JSON.parse(crudo);
    return Array.isArray(v)
      ? v.filter((e): e is Etiqueta => !!e && typeof e.id === "string" && typeof e.nombre === "string" && e.color in COLORES).slice(0, MAX_ETIQUETAS)
      : [];
  } catch {
    return [];
  }
}

/** Crea una etiqueta. Devuelve el motivo si no se pudo. */
export async function crearEtiqueta(db: Db, nombreCrudo: string, color: string): Promise<string | null> {
  const nombre = nombreCrudo.replace(/\s+/g, " ").trim().slice(0, 24);
  if (!nombre) return "Ponle un nombre a la etiqueta.";
  if (!(color in COLORES)) return "Elige un color de la lista.";
  const lista = await leerEtiquetas(db);
  if (lista.some((e) => e.nombre.toLowerCase() === nombre.toLowerCase())) return "Ya existe una etiqueta con ese nombre.";
  if (lista.length >= MAX_ETIQUETAS) return `Ya hay ${MAX_ETIQUETAS} etiquetas: borra alguna primero.`;
  lista.push({ id: crypto.randomUUID().replace(/-/g, "").slice(0, 10), nombre, color });
  await new SettingsRepo(db).set(CLAVE, JSON.stringify(lista));
  return null;
}

export async function borrarEtiqueta(db: Db, id: string): Promise<void> {
  const lista = (await leerEtiquetas(db)).filter((e) => e.id !== id);
  await new SettingsRepo(db).set(CLAVE, JSON.stringify(lista));
}

/** Los ids de las etiquetas de una conversación, según su metadata. */
export function etiquetasDe(metadata: string | null | undefined): string[] {
  if (!metadata) return [];
  try {
    const v = (JSON.parse(metadata) as { etiquetas?: unknown }).etiquetas;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Pone o quita una etiqueta de una conversación. Devuelve si quedó puesta. */
export async function alternarEtiqueta(db: Db, conversationId: string, etiquetaId: string): Promise<boolean> {
  const fila = await db.first<{ metadata: string | null }>("SELECT metadata FROM conversations WHERE id = ?", [conversationId]);
  const actuales = etiquetasDe(fila?.metadata);
  const puesta = !actuales.includes(etiquetaId);
  const nuevas = puesta ? [...actuales, etiquetaId] : actuales.filter((x) => x !== etiquetaId);
  await cambiarMetadata(db, conversationId, { etiquetas: nuevas.length ? nuevas : undefined });
  return puesta;
}

/** Condición SQL de «tiene esta etiqueta»: lleva un `?` con el id. */
export const SQL_CON_ETIQUETA =
  "(json_valid(c.metadata) AND EXISTS (SELECT 1 FROM json_each(c.metadata, '$.etiquetas') je WHERE je.value = ?))";
