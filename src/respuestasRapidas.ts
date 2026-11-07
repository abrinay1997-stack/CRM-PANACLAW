// Respuestas rápidas: frases que el equipo repite («Nuestro horario es…», «Te paso
// la cotización…»). Se guardan en el ajuste `respuestas_rapidas` (sin migración).
// `{nombre}` se cambia por el primer nombre del cliente al usarla.

import { Db } from "./db/client";
import { SettingsRepo } from "./db/settings";

export interface RespuestaRapida {
  /** Cómo se encuentra: «horario» (se busca escribiendo «/hor…»). */
  atajo: string;
  texto: string;
}

const CLAVE = "respuestas_rapidas";
export const MAX_RESPUESTAS = 40;
const MAX_TEXTO = 1000;

/** El atajo en minúsculas y sin espacios ni «/», como se escribe para buscarlo. */
export function limpiarAtajo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export async function leerRespuestas(db: Db): Promise<RespuestaRapida[]> {
  const crudo = await new SettingsRepo(db).get(CLAVE);
  if (!crudo) return [];
  try {
    const v = JSON.parse(crudo);
    if (!Array.isArray(v)) return [];
    return v
      .filter((r): r is RespuestaRapida => !!r && typeof r.atajo === "string" && typeof r.texto === "string")
      .slice(0, MAX_RESPUESTAS);
  } catch {
    return [];
  }
}

/** Añade (o reemplaza, si el atajo ya existe). Devuelve el motivo si no se pudo. */
export async function guardarRespuesta(db: Db, atajoCrudo: string, textoCrudo: string): Promise<string | null> {
  const atajo = limpiarAtajo(atajoCrudo);
  const texto = textoCrudo.trim();
  if (!atajo) return "Ponle un nombre corto, por ejemplo «horario».";
  if (!texto) return "Escribe el texto de la respuesta.";
  if (texto.length > MAX_TEXTO) return `Es muy larga: máximo ${MAX_TEXTO} caracteres.`;
  const lista = await leerRespuestas(db);
  const i = lista.findIndex((r) => r.atajo === atajo);
  if (i >= 0) lista[i] = { atajo, texto };
  else if (lista.length >= MAX_RESPUESTAS) return `Ya hay ${MAX_RESPUESTAS}: borra alguna primero.`;
  else lista.push({ atajo, texto });
  await new SettingsRepo(db).set(CLAVE, JSON.stringify(lista));
  return null;
}

export async function borrarRespuesta(db: Db, atajo: string): Promise<void> {
  const lista = (await leerRespuestas(db)).filter((r) => r.atajo !== atajo);
  await new SettingsRepo(db).set(CLAVE, JSON.stringify(lista));
}
