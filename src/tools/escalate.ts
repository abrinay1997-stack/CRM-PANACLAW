import type { Env } from "../env";
import { Db } from "../db/client";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { notifyOwner } from "./handoffHuman";

export interface EscalationInput {
  reason: string;
  summary: string;
  category: string;
}

export interface EscalationResult {
  ticketId: string;
  /** false = la conversación ya tenía un ticket abierto; no se avisó de nuevo. */
  notified: boolean;
}

/**
 * Abre el ticket y avisa al dueño — el único camino por el que el bot deja de
 * atender a un cliente.
 *
 * Vive aparte de handoffHuman porque `pauseBot` también lo necesita: el modelo
 * elige esa tool cuando el cliente pide una persona (su descripción dice
 * justamente "el dueño humano tomará el control"), y hasta ahora pausaba la
 * conversación sin ticket y sin aviso. El cliente se quedaba esperando en
 * silencio y el dueño no se enteraba nunca.
 *
 * Si la conversación ya tiene un ticket abierto no se abre otro ni se avisa
 * doble: `conversations.open_ticket_id` guarda uno solo por conversación, así
 * que llamar handoffHuman y pauseBot en el mismo turno —en cualquier orden—
 * deja un ticket y un aviso.
 */
export async function openTicketAndNotify(
  env: Env,
  conversationId: string | null,
  input: EscalationInput,
): Promise<EscalationResult> {
  const db = new Db(env.DB);
  const tickets = new TicketsRepo(db);
  const convs = new ConversationsRepo(db);

  if (conversationId) {
    const conv = await convs.getById(conversationId);
    const openId = conv?.open_ticket_id;
    if (openId) {
      const existing = await tickets.getById(openId);
      if (existing && existing.status !== "resolved") {
        return { ticketId: openId, notified: false };
      }
    }
  }

  const ticketId = await tickets.create({
    conversationId,
    category: input.category,
    summary: `[${input.reason}] ${input.summary}`,
    transcript: "", // populated by agent if it has access; left blank otherwise
  });
  if (conversationId) await convs.setOpenTicket(conversationId, ticketId);

  await notifyOwner(env, {
    reason: input.reason,
    summary: input.summary,
    ticketId,
    category: input.category,
    conversationId,
  });

  return { ticketId, notified: true };
}
