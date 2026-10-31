import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";

export function captureLeadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Captura un lead (cliente interesado en comprar) para que el dueño venda después. Una vez por conversación: si ya lo anotaste, llamarla de nuevo solo completa sus datos. NO es para quien busca empleo, ofrece sus servicios, viene a vender algo o busca algo que el negocio no vende (un préstamo, por ejemplo): esos no son leads.",
    inputSchema: z.object({
      name: z.string().optional().describe("Nombre de la persona (no su oficio ni su negocio)"),
      contact: z.string().optional().describe("Teléfono o email"),
      intent: z.string().describe("Qué quiere el cliente, en 1-2 frases"),
      notes: z.string().optional(),
    }),
    execute: async ({ name, contact, intent, notes }) => {
      const convId = getConversationId();
      const leads = new LeadsRepo(new Db(env.DB));
      // Un lead por conversación. El 31-oct-2026 el bot anotó a la misma
      // persona 8 veces, una por mensaje. Si ya hay uno abierto, se completa
      // con lo nuevo y no se avisa otra vez al dueño.
      const abierto = convId ? await leads.abiertoDe(convId) : null;
      if (abierto) {
        await leads.completar(abierto.id, { name, contact, intent, notes });
        return { leadId: abierto.id, message: "Ya estaba anotado: se completaron sus datos. No lo anotes otra vez." };
      }
      const leadId = await leads.create({
        conversationId: convId,
        name,
        contact,
        channelUserId: null,
        intent,
        notes,
      });

      // Optional external export — Pro-tier feature, skipped if no creds
      // (Implementation deferred to Task 7.4 — adds Google Sheets export)

      // Un interesado que deja sus datos es una venta a punto de cerrarse, y
      // el lead quedaba en el panel sin que nadie se enterara. Se avisa al
      // Telegram del dueño (si está vinculado), con los botones de siempre.
      // Nunca bloquea la respuesta al cliente.
      try {
        const { avisarAlDueno } = await import("../owner/avisos");
        // El bot suele capturar en dos pasos (primero el nombre, después el
        // correo): un aviso de interesado por conversación cada media hora
        // basta. Se cuentan los LEADS y no cualquier aviso: el de «mensaje
        // nuevo» sale en cada conversación, y con él este no llegaba nunca.
        if (convId) {
          const previos = await new Db(env.DB).first<{ n: number }>(
            "SELECT COUNT(*) AS n FROM leads WHERE conversation_id = ? AND id != ? AND created_at > ?",
            [convId, leadId, Date.now() - 30 * 60_000],
          );
          if ((previos?.n ?? 0) > 0) return { leadId, message: "Lead capturado." };
        }
        await avisarAlDueno(env, {
          titulo: "🛍 Interesado",
          cuerpo: [intent, name && `Nombre: ${name}`, contact && `Contacto: ${contact}`, notes && `Nota: ${notes}`]
            .filter(Boolean)
            .join("\n"),
          conversationId: convId,
        });
      } catch (e) {
        console.warn("[captureLead] no se pudo avisar al dueño:", e);
      }

      return { leadId, message: "Lead capturado." };
    },
  });
}
