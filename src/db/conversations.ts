import { Db } from "./client";
import { detachConversation } from "./aiUsage";

export interface Conversation {
  id: string;
  channel: string;
  channel_user_id: string;
  display_name: string | null;
  started_at: number;
  last_message_at: number;
  paused_until: number | null;
  open_ticket_id: string | null;
  metadata: string | null;
}

function makeConvId(channel: string, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  async getOrCreate(
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): Promise<Conversation> {
    const id = makeConvId(channel, channelUserId);
    const existing = await this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    );
    if (existing) return existing;

    const now = Date.now();
    await this.db.run(
      `INSERT INTO conversations (id, channel, channel_user_id, display_name, started_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channel, channelUserId, displayName ?? null, now, now],
    );
    return (await this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    ))!;
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.db.first<Conversation>(
      "SELECT * FROM conversations WHERE id = ?",
      [id],
    );
  }

  async setPausedUntil(id: string, until: number | null): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET paused_until = ? WHERE id = ?",
      [until, id],
    );
  }

  async isPaused(id: string): Promise<boolean> {
    const conv = await this.getById(id);
    if (!conv?.paused_until) return false;
    return conv.paused_until > Date.now();
  }

  async touchLastMessage(id: string, when: number = Date.now()): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET last_message_at = ? WHERE id = ?",
      [when, id],
    );
  }

  /**
   * Borra una conversación y todo lo que cuelga de ella.
   *
   * Las tablas se limpian a mano en vez de confiar en `ON DELETE CASCADE`:
   * la mitad de ellas (customer_facts, tracked_links, keyword_hits,
   * conv_labels, template_sends, followup_sends) ni siquiera tiene llave
   * foránea, y sin esto quedarían huérfanas ensuciando campañas y segmentos.
   *
   * Lo que NO se borra, a propósito:
   *  • leads y tickets — son el resultado del negocio, no el chat. Se les
   *    suelta el vínculo (igual que declara el esquema con SET NULL).
   *  • el gasto de IA ya facturado — se le quita el vínculo, pero el dinero
   *    gastado no puede desaparecer del panel ni del tope mensual.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    const childTables = [
      "messages",
      "conversation_insights",
      "customer_facts",
      "tracked_links",
      "keyword_hits",
      "conv_labels",
      "template_sends",
      "followup_sends",
    ];
    for (const table of childTables) {
      await this.db.run(`DELETE FROM ${table} WHERE conversation_id = ?`, [id]);
    }
    await this.db.run("UPDATE leads SET conversation_id = NULL WHERE conversation_id = ?", [id]);
    await this.db.run("UPDATE tickets SET conversation_id = NULL WHERE conversation_id = ?", [id]);
    await detachConversation(this.db, id);
    await this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
    return true;
  }

  async setOpenTicket(id: string, ticketId: string | null): Promise<void> {
    await this.db.run(
      "UPDATE conversations SET open_ticket_id = ? WHERE id = ?",
      [ticketId, id],
    );
  }
}
