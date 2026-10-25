/**
 * La base de conocimiento: los documentos del PANEL (D1 `kb_docs`) y su índice
 * de búsqueda en Vectorize.
 *
 * El panel es la ÚNICA fuente (decisión del dueño, 25-oct-2026). Antes
 * convivían dos: las fichas del repo (scripts/kb-fixtures.json, bajadas del
 * sitio) y los documentos del panel, y se contradecían —el panel decía que eBot
 * se entrega en 48 horas; el sitio, en 3 a 5 días— y el bot contestaba con el
 * que encontrara primero.
 *
 * Las fichas del repo quedan para dos cosas: SEMBRAR el panel una sola vez en
 * una instalación nueva (sembrarKbSiVacia) y saber qué ids viejos hay que
 * borrar del índice. El bot nunca las lee.
 *
 * El índice es un ESPEJO del panel, no una fuente: searchKb lo usa para saber
 * QUÉ documento contesta, y el texto lo toma de D1. Un documento editado se lee
 * nuevo en el siguiente mensaje, y el cron re-indexa lo que cambió
 * (sincronizarIndiceSiCambio) para que también se encuentre bien.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
import { reindexKb, type KbChunk } from "./reindex";
import kbFixtures from "../../scripts/kb-fixtures.json";

export interface KbDoc {
  id: string;
  title: string;
  content: string;
  updated_at: number;
}

/** Max content length per doc — bounds the chunk count (≤ MAX_CHUNKS). */
export const MAX_DOC_CHARS = 24_000;
const CHUNK_CHARS = 1_200;
export const MAX_CHUNKS = 24;

/** Las fichas del repo: solo semilla y lista de ids viejos (ver arriba). */
export const FIXTURE_CHUNKS = kbFixtures as KbChunk[];

export class KbDocsRepo {
  constructor(private readonly db: Db) {}

  async list(): Promise<KbDoc[]> {
    return this.db.all<KbDoc>("SELECT * FROM kb_docs ORDER BY updated_at DESC");
  }

  async getById(id: string): Promise<KbDoc | null> {
    return this.db.first<KbDoc>("SELECT * FROM kb_docs WHERE id = ?", [id]);
  }

  /** Varios documentos por id, en un mapa. Los que no existen no aparecen. */
  async byIds(ids: string[]): Promise<Map<string, KbDoc>> {
    const unicos = [...new Set(ids)].slice(0, 100);
    if (unicos.length === 0) return new Map();
    const filas = await this.db.all<KbDoc>(
      `SELECT * FROM kb_docs WHERE id IN (${unicos.map(() => "?").join(",")})`,
      unicos,
    );
    return new Map(filas.map((d) => [d.id, d]));
  }

  async upsert(doc: { id: string; title: string; content: string }): Promise<void> {
    await this.db.run(
      `INSERT INTO kb_docs (id, title, content, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, content = excluded.content, updated_at = excluded.updated_at`,
      [doc.id, doc.title, doc.content, Date.now()],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run("DELETE FROM kb_docs WHERE id = ?", [id]);
  }
}

/** Split content into ~CHUNK_CHARS pieces on paragraph boundaries. */
export function chunkContent(content: string): string[] {
  const paras = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      push();
      for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if (current.length + p.length + 2 > CHUNK_CHARS) push();
    current = current ? `${current}\n\n${p}` : p;
  }
  push();
  return chunks.slice(0, MAX_CHUNKS);
}

function vectorIds(docId: string): string[] {
  return Array.from({ length: MAX_CHUNKS }, (_, i) => `dash:${docId}#${i}`);
}

/** `dash:<docId>#<i>` → el documento y el pedazo; null si el vector no es del panel. */
export function pedazoDelPanel(vectorId: string): { docId: string; indice: number } | null {
  const m = /^dash:(.+)#(\d+)$/.exec(vectorId ?? "");
  return m ? { docId: m[1], indice: Number(m[2]) } : null;
}

/** Chunks for one dashboard doc, title-prefixed so matches carry context. */
export function docChunks(doc: KbDoc): KbChunk[] {
  return chunkContent(doc.content).map((content, i) => ({
    id: `dash:${doc.id}#${i}`,
    title: doc.title,
    content,
    source: "dashboard",
  }));
}

/** Re-embed one doc: blanket-delete its old vectors, then upsert fresh ones. */
export async function indexDoc(env: Env, doc: KbDoc): Promise<{ indexed: number }> {
  await env.KB.deleteByIds(vectorIds(doc.id));
  return reindexKb(env, docChunks(doc));
}

/** Remove a deleted doc's vectors from the index. */
export async function removeDocVectors(env: Env, docId: string): Promise<void> {
  await env.KB.deleteByIds(vectorIds(docId));
}

/** All dashboard docs as chunks (for the global reindex). */
export async function dashboardChunks(env: Env): Promise<KbChunk[]> {
  const docs = await new KbDocsRepo(new Db(env.DB)).list();
  return docs.flatMap(docChunks);
}

/**
 * Siembra el panel con las fichas del repo, UNA sola vez y solo si el panel no
 * tiene ningún documento: es lo que deja el instalador en una instalación
 * nueva. Si el panel ya tenía documentos (como el bot de PanaClaw), no copia
 * nada y anota igual que ya pasó: lo del repo deja de contar para siempre.
 */
export async function sembrarKbSiVacia(env: Env): Promise<number> {
  const settings = new SettingsRepo(new Db(env.DB));
  if ((await settings.get(SETTING_KEYS.kbSembrada)) === "1") return 0;
  const repo = new KbDocsRepo(new Db(env.DB));
  let sembrados = 0;
  if ((await repo.list()).length === 0) {
    for (const f of FIXTURE_CHUNKS) {
      if (!f.content?.trim()) continue;
      await repo.upsert({ id: f.id, title: f.title || f.id, content: f.content.slice(0, MAX_DOC_CHARS) });
      sembrados++;
    }
  }
  await settings.set(SETTING_KEYS.kbSembrada, "1");
  return sembrados;
}

/** Huella de lo que hay en el panel: cambia si se edita, crea o borra un documento. */
export async function firmaDeKb(env: Env): Promise<string> {
  const filas = await new Db(env.DB).all<{ id: string; updated_at: number; largo: number }>(
    "SELECT id, updated_at, length(content) AS largo FROM kb_docs ORDER BY id",
  );
  const texto = filas.map((f) => `${f.id}|${f.updated_at}|${f.largo}`).join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reindex general: el índice queda IGUAL al panel. Sube cada documento y borra
 * lo que no sale de él: las fichas del repo (ya no son fuente) y los pedazos
 * que sobraron al acortar un documento. Los de un documento borrado por SQL no
 * se pueden listar, pero searchKb tampoco los sirve: solo devuelve documentos
 * que existen en el panel.
 */
export async function reindexAll(env: Env): Promise<{ indexed: number; purged: number }> {
  await sembrarKbSiVacia(env);
  const firma = await firmaDeKb(env);
  const docs = await new KbDocsRepo(new Db(env.DB)).list();
  const chunks = docs.flatMap(docChunks);
  const vivos = new Set(chunks.map((c) => c.id));
  const { indexed } = await reindexKb(env, chunks);

  const sobran = [
    ...new Set([...FIXTURE_CHUNKS.map((f) => f.id), ...docs.flatMap((d) => vectorIds(d.id))]),
  ].filter((id) => !vivos.has(id));
  // En lotes chicos: Vectorize rechaza un deleteByIds grande (Baby Caleb,
  // 24-sep-2026: ~480 ids de una vez devolvieron 500).
  for (let i = 0; i < sobran.length; i += 50) await env.KB.deleteByIds(sobran.slice(i, i + 50));

  await new SettingsRepo(new Db(env.DB)).set(SETTING_KEYS.kbFirmaIndice, firma);
  return { indexed, purged: sobran.length };
}

/**
 * Lo que corre el cron cada hora: si el panel cambió desde el último reindex
 * —por el editor, por la consola de Telegram o directo en la base—, el índice
 * se pone al día solo. Sin esto, un cambio hecho fuera del editor se leía bien
 * (searchKb toma el texto de D1) pero el buscador lo seguía encontrando por lo
 * que decía antes.
 */
export async function sincronizarIndiceSiCambio(env: Env): Promise<{ reindexado: boolean }> {
  const guardada = await new SettingsRepo(new Db(env.DB)).get(SETTING_KEYS.kbFirmaIndice);
  if (guardada && guardada === (await firmaDeKb(env))) return { reindexado: false };
  await reindexAll(env);
  return { reindexado: true };
}
