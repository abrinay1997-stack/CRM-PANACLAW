import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { KbDocsRepo, chunkContent, pedazoDelPanel } from "../kb/docs";

export interface SearchKbResult {
  title: string;
  content: string;
  score: number;
}

/** Cuántos pedazos se le devuelven al modelo. */
const RESULTADOS = 8;
/**
 * Cuántos se le piden al índice: más de los que se devuelven, porque los que
 * no son del panel (fichas viejas del repo, documentos ya borrados) se
 * descartan y no deben dejar al modelo con menos de lo que necesita.
 *
 * 100 es el máximo de Vectorize cuando no se piden valores ni metadata, y es lo
 * que hace falta: hasta que el primer reindex del cron las borre, hay 85 fichas
 * viejas en el índice que hablan de los mismos temas que el panel. Con 50, una
 * pregunta cuyos 50 parecidos fueran todos fichas viejas se quedaba sin nada,
 * aunque el panel tuviera la respuesta (lo señaló Codex en el PR #41).
 */
const CANDIDATOS = 100;

/** Un borrador de «Mejoras» que nadie terminó: no se le cita al cliente. */
const HUECO_SIN_LLENAR = /\[COMPLETA AQU[IÍ]/i;

/**
 * Esta tool decía en su descripción: "Si top-1 score < 0.7 no hay match útil —
 * escala". No era un filtro del código, era una INSTRUCCIÓN al modelo, y un
 * umbral inventado: bge-m3 puntúa una pregunta en español contra un párrafo
 * que la contesta típicamente entre 0.5 y 0.7. O sea, se le estaba pidiendo al
 * bot que descartara respuestas correctas y escalara igual.
 *
 * Se vio primero en Baby Caleb (mismo código): una clienta preguntó el envío a
 * Tocumen —que estaba en la base de conocimiento— y el bot contestó "no tengo
 * esa tarifa en el sistema". El dato estaba; el umbral lo tapó. Allá se
 * arregló el 29-sep-2026 y aquí seguía igual, también en el system prompt.
 *
 * Ahora no se le da ningún número mágico: se le dice que lea el contenido y
 * decida por lo que dice, no por el parecido de redacción.
 *
 * Y lo que devuelve sale SOLO del panel (25-oct-2026): el índice dice qué
 * documento y qué pedazo contestan, y el texto se toma de D1. Así un vector
 * viejo —una ficha del repo, un documento borrado o editado— nunca le llega al
 * modelo con lo que decía antes. De paso deja de depender del `metadata` del
 * índice, que esta consulta nunca pidió (`returnMetadata`): en Vectorize V2 no
 * viene si no se pide, y entonces cada resultado llegaba sin título ni texto.
 */
export function searchKbTool(env: Env) {
  return tool({
    description:
      "Busca en la base de conocimiento del negocio (sus documentos del panel): qué ofrece, cuánto " +
      "cuesta, qué incluye, plazos, formas de pago y preguntas frecuentes. Devuelve los fragmentos más " +
      "parecidos, ordenados. " +
      "LEE EL CONTENIDO antes de decidir: el `score` mide parecido de REDACCIÓN, no si la respuesta " +
      "está ahí. Un fragmento con score bajo puede contener el dato exacto que te piden — úsalo igual. " +
      "Solo di que no tienes el dato cuando hayas leído los fragmentos y ninguno conteste la pregunta.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Pregunta o tema a buscar"),
    }),
    execute: async ({ query }) => {
      try {
        const embedding = await env.AI.run("@cf/baai/bge-m3", {
          text: query,
        });
        const vec = (embedding as any).data?.[0];
        if (!Array.isArray(vec)) {
          return { error: "transient" as const, message: "embedding shape unexpected" };
        }
        const matches = ((await env.KB.query(vec, { topK: CANDIDATOS })).matches ?? []) as any[];
        const pedazos = matches.map((m) => ({ ...pedazoDelPanel(String(m.id ?? "")), score: m.score ?? 0 }));
        const docs = await new KbDocsRepo(new Db(env.DB)).byIds(
          pedazos.map((p) => p.docId).filter((id): id is string => !!id),
        );

        const results: SearchKbResult[] = [];
        const trozosDe = new Map<string, string[]>();
        for (const p of pedazos) {
          const doc = p.docId ? docs.get(p.docId) : undefined;
          if (!doc || p.indice === undefined) continue;
          if (!trozosDe.has(doc.id)) trozosDe.set(doc.id, chunkContent(doc.content));
          const content = trozosDe.get(doc.id)![p.indice];
          if (!content || HUECO_SIN_LLENAR.test(content)) continue;
          results.push({ title: doc.title, content, score: p.score });
          if (results.length >= RESULTADOS) break;
        }
        return { results };
      } catch (e: any) {
        return { error: "transient" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
