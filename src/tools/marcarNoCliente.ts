import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { marcarNoClientePorElBot } from "../noCliente";

/**
 * «Esta persona no busca nada de lo que vendemos.» La llama el bot, en el primer
 * mensaje en que queda claro, sea cual sea la razón. Con la marca: no se anota
 * como lead, Meta no se entera, no hay seguimiento y, después de UNA despedida
 * amable, el bot calla (src/noCliente.ts). El panel la enseña con el motivo y
 * un botón para quitarla.
 */
export function marcarNoClienteTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Marca a esta persona como «no es cliente». Úsala cuando quede CLARO que no busca nada de lo que PanaClaw vende ni de lo que puede resolver: pide dinero, un padrino o un regalo, busca empleo, habla de su finca o de otra cosa, o pregunta algo ajeno. NO la uses si tiene una duda real, aunque la diga mal; ni con quien describe su negocio o su proyecto. Después de llamarla, despídete UNA vez en una o dos líneas.",
    inputSchema: z.object({
      motivo: z.string().max(120).describe("En pocas palabras, qué busca la persona (ej.: «pide un padrino», «habla de su finca», «busca trabajo»)"),
    }),
    execute: async ({ motivo }) => {
      const convId = getConversationId();
      if (!convId) return { ok: false };
      const marcada = await marcarNoClientePorElBot(new Db(env.DB), convId, motivo);
      return {
        ok: marcada,
        instruccion: "Despídete ahora en una o dos líneas, con respeto, diciendo qué hace el negocio y que de eso no puedes ayudarle. Sin preguntas y sin ofrecer planes.",
      };
    },
  });
}
