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

/**
 * Quienes llegaron por un anuncio en los últimos `dias` días, agrupados.
 *
 * Cuenta desde la LLEGADA, no desde que empezó la conversación (hallazgo de
 * Codex): quien ya había escrito hace meses y vuelve por un anuncio cuenta
 * para ese anuncio, y lo que contestó o compró antes no se le apunta. La
 * llegada es el clic guardado; si no hay, el último mensaje con la marca
 * [ANUNCIO: …]; y si tampoco, el mensaje automático del anuncio.
 */
export async function medirPorAnuncio(env: Env, dias: number, ahora = Date.now()): Promise<FilaAnuncio[]> {
  const db = new Db(env.DB);
  const desde = ahora - dias * DIA;
  const activas = "SELECT id FROM conversations WHERE last_message_at > ?";
  const convs = await db.all<{ id: string; metadata: string | null }>(
    "SELECT id, metadata FROM conversations WHERE last_message_at > ?",
    [desde],
  );
  if (convs.length === 0) return [];
  const mensajes = await db.all<{ conversation_id: string; content: string; created_at: number }>(
    `SELECT conversation_id, content, created_at FROM messages
     WHERE role = 'user' AND conversation_id IN (${activas})
     ORDER BY created_at ASC LIMIT 20000`,
    [desde],
  );
  const leads = await db.all<{ conversation_id: string; status: string; created_at: number }>(
    `SELECT conversation_id, status, created_at FROM leads WHERE conversation_id IN (${activas})`,
    [desde],
  );

  const delCliente = new Map<string, { content: string; created_at: number }[]>();
  for (const m of mensajes) {
    const lista = delCliente.get(m.conversation_id) ?? [];
    lista.push(m);
    delCliente.set(m.conversation_id, lista);
  }
  const leadsDe = new Map<string, { status: string; created_at: number }[]>();
  for (const l of leads) leadsDe.set(l.conversation_id, [...(leadsDe.get(l.conversation_id) ?? []), l]);

  const filas = new Map<string, FilaAnuncio>();
  for (const c of convs) {
    const suyos = delCliente.get(c.id) ?? [];
    const clic = leerMetadata(c.metadata).anuncio as { source_id?: string; titular?: string; at?: number } | undefined;
    const conMarca = [...suyos].reverse().find((m) => /^\[ANUNCIO: /m.test(m.content));
    const llegada =
      typeof clic?.at === "number"
        ? clic.at
        : (conMarca?.created_at ?? (suyos[0] && esAperturaDeAnuncio(suyos[0].content) ? suyos[0].created_at : null));
    if (llegada === null || llegada < desde) continue;

    const titular = clic?.titular || (conMarca && titularDeMarca(conMarca.content)) || SIN_IDENTIFICAR;
    const anuncioId = clic?.source_id ?? null;
    const clave = anuncioId ? `id:${anuncioId}` : `titular:${titular}`;
    const fila = filas.get(clave) ?? { titular, anuncioId, llegaron: 0, contestaron: 0, noClientes: 0, leads: 0, ventas: 0 };

    const noCliente = Boolean(marcaNoCliente(c.metadata));
    const despues = suyos.filter((m) => m.created_at >= llegada).map((m) => m.content);
    const susLeads = (leadsDe.get(c.id) ?? []).filter((l) => l.created_at >= llegada).map((l) => l.status);
    fila.llegaron++;
    if (escribioAlgoPropio(despues)) fila.contestaron++;
    if (noCliente) fila.noClientes++;
    if (!noCliente && susLeads.some((s) => s !== "lost")) fila.leads++;
    if (susLeads.includes("sold")) fila.ventas++;
    filas.set(clave, fila);
  }
  return [...filas.values()].sort((a, b) => b.llegaron - a.llegaron || b.contestaron - a.contestaron);
}
