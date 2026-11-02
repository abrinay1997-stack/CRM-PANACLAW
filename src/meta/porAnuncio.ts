// Cuánto rinde cada anuncio, contado en el CRM (auditoría de Meta Ads,
// 1-nov-2026). Es la tabla con la que se decide cada lunes qué anuncio se
// pausa: Meta cuenta conversaciones; aquí se ve cuántas contestaron, cuántas no
// eran clientes, cuántas fueron lead y cuántas compraron.
//
// Una fila por anuncio: por su id cuando el mensaje lo trajo (se guarda desde
// el 1-nov-2026, src/meta/conversiones.ts), y si no, por el titular que quedó
// en la marca [ANUNCIO: …] del primer mensaje. Las conversaciones de antes de
// esa marca, que solo traen el mensaje automático, van en «Anuncio sin
// identificar».
//
// El gasto no está: vive en el Administrador de anuncios y el CRM no tiene
// acceso a él. El coste por conversación que contesta es ese gasto dividido
// entre «Contestaron».
import type { Env } from "../env";
import { Db } from "../db/client";
import { escribioAlgoPropio, esAperturaDeAnuncio, marcaNoCliente } from "../noCliente";

const DIA = 24 * 60 * 60 * 1000;

export interface FilaAnuncio {
  /** Lo que se enseña: el titular del anuncio. */
  titular: string;
  /** El id del anuncio en Meta, si vino. */
  anuncioId: string | null;
  llegaron: number;
  /** Escribieron algo propio además del mensaje automático (src/noCliente.ts). */
  contestaron: number;
  noClientes: number;
  /** Leads que no se perdieron, de quien sí es cliente. */
  leads: number;
  ventas: number;
}

export const SIN_IDENTIFICAR = "Anuncio sin identificar";

function leerMetadata(texto: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(texto ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** El titular de la marca [ANUNCIO: llegó desde un anuncio de Meta: «titular» · «texto»]. */
export function titularDeMarca(contenido: string): string | null {
  const m = contenido.match(/^\[ANUNCIO: [^\n«]*«([^»\n]+)»/m);
  return m ? m[1].trim() : null;
}

/** Las conversaciones que empezaron en los últimos `dias` días y llegaron por un anuncio, agrupadas. */
export async function medirPorAnuncio(env: Env, dias: number, ahora = Date.now()): Promise<FilaAnuncio[]> {
  const db = new Db(env.DB);
  const desde = ahora - dias * DIA;
  const convs = await db.all<{ id: string; metadata: string | null }>(
    "SELECT id, metadata FROM conversations WHERE started_at > ?",
    [desde],
  );
  if (convs.length === 0) return [];
  const mensajes = await db.all<{ conversation_id: string; content: string }>(
    `SELECT conversation_id, content FROM messages
     WHERE role = 'user' AND conversation_id IN (SELECT id FROM conversations WHERE started_at > ?)
     ORDER BY created_at ASC LIMIT 20000`,
    [desde],
  );
  const leads = await db.all<{ conversation_id: string; status: string }>(
    `SELECT conversation_id, status FROM leads
     WHERE conversation_id IN (SELECT id FROM conversations WHERE started_at > ?)`,
    [desde],
  );

  const delCliente = new Map<string, string[]>();
  for (const m of mensajes) {
    const lista = delCliente.get(m.conversation_id) ?? [];
    lista.push(m.content);
    delCliente.set(m.conversation_id, lista);
  }
  const estados = new Map<string, string[]>();
  for (const l of leads) estados.set(l.conversation_id, [...(estados.get(l.conversation_id) ?? []), l.status]);

  const filas = new Map<string, FilaAnuncio>();
  for (const c of convs) {
    const suyos = delCliente.get(c.id) ?? [];
    const meta = leerMetadata(c.metadata);
    const clic = meta.anuncio as { source_id?: string; titular?: string } | undefined;
    const conMarca = suyos.find((m) => /^\[ANUNCIO: /m.test(m));
    const delAnuncio = Boolean(clic) || Boolean(conMarca) || (suyos[0] !== undefined && esAperturaDeAnuncio(suyos[0]));
    if (!delAnuncio) continue;

    const titular = clic?.titular || (conMarca && titularDeMarca(conMarca)) || SIN_IDENTIFICAR;
    const anuncioId = clic?.source_id ?? null;
    const clave = anuncioId ? `id:${anuncioId}` : `titular:${titular}`;
    const fila = filas.get(clave) ?? { titular, anuncioId, llegaron: 0, contestaron: 0, noClientes: 0, leads: 0, ventas: 0 };

    const noCliente = Boolean(marcaNoCliente(c.metadata));
    const suyosEstados = estados.get(c.id) ?? [];
    fila.llegaron++;
    if (escribioAlgoPropio(suyos)) fila.contestaron++;
    if (noCliente) fila.noClientes++;
    if (!noCliente && suyosEstados.some((s) => s !== "lost")) fila.leads++;
    if (suyosEstados.includes("sold")) fila.ventas++;
    filas.set(clave, fila);
  }
  return [...filas.values()].sort((a, b) => b.llegaron - a.llegaron || b.contestaron - a.contestaron);
}
