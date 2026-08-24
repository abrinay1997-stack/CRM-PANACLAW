import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { ConversationsRepo } from "../db/conversations";

export function pauseBotTool(env: Env, getConversationId: () => string | null) {
  return tool({
    // La descripción importa tanto como el código: con la anterior ("el dueño
    // humano tomará el control") el modelo elegía esta tool cuando el cliente
    // pedía una persona, y la conversación se pausaba sin ticket ni aviso.
    description:
      "Silencia al bot en esta conversación por N minutos. Para escalar a una " +
      "persona usa handoffHuman, no ésta: handoffHuman abre el ticket con el " +
      "contexto del caso. Ésta solo silencia; abre ticket y avisa al dueño " +
      "igual, para que nunca quede un cliente esperando sin que nadie sepa.",
    inputSchema: z.object({
      minutes: z.number().int().min(5).max(1440).default(60),
      reason: z.string().optional(),
    }),
    execute: async ({ minutes, reason }) => {
      const convId = getConversationId();
      if (!convId) return { error: "no_conversation" as const };
      const convs = new ConversationsRepo(new Db(env.DB));
      const until = Date.now() + minutes * 60_000;
      await convs.setPausedUntil(convId, until);

      // Pausar al bot deja a un cliente esperando a una persona. Eso es una
      // escalación, aunque el modelo no haya llamado handoffHuman: mismo
      // ticket y mismo aviso. Si la conversación ya tenía ticket abierto,
      // openTicketAndNotify no duplica ni vuelve a avisar.
      const { openTicketAndNotify } = await import("./escalate");
      const { ticketId } = await openTicketAndNotify(env, convId, {
        reason: "bot pausado",
        summary: reason?.trim()
          ? reason.trim()
          : `El bot se pausó ${minutes} min — el cliente espera a una persona.`,
        category: "other",
      });

      return { pausedUntil: until, ticketId };
    },
  });
}
