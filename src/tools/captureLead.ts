import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { Db } from "../db/client";
import { LeadsRepo } from "../db/leads";
import { noClienteDe, escribioAlgoPropio, MOTIVO_NO_CLIENTE } from "../noCliente";

export function captureLeadTool(env: Env, getConversationId: () => string | null) {
  return tool({
    description:
      "Captura un lead (cliente interesado en comprar) para que el dueño venda después. Solo cuando la persona dijo qué negocio tiene o pidió precio, fecha o empezar: el mensaje automático del anuncio, un saludo o un «ok» no la vuelven lead. Una vez por conversación: si ya lo anotaste, llamarla de nuevo solo completa sus datos. NO es para quien busca empleo, ofrece sus servicios, viene a vender algo o busca algo que el negocio no vende (un préstamo, por ejemplo): esos no son leads.",
    inputSchema: z.object({
      name: z.string().optional().describe("Nombre de la persona (no su oficio ni su negocio)"),
      contact: z.string().optional().describe("Teléfono o email"),
      intent: z.string().describe("Qué quiere el cliente, en 1-2 frases"),
      notes: z.string().optional(),
    }),
    execute: async ({ name, contact, intent, notes }) => {
      const convId = getConversationId();
      const db = new Db(env.DB);
      const leads = new LeadsRepo(db);
      // Quien no viene a comprar no es un lead, lo diga el modelo o no
      // (src/noCliente.ts): el 31-oct-2026 entraron como leads un señor que
      // pedía un préstamo y un diseñador que buscaba empleo.
      const noCliente = convId ? await noClienteDe(db, convId).catch(() => null) : null;
      if (noCliente) {
        return {
          leadId: null,
          message: `No se anotó: esta persona no viene a comprar (${MOTIVO_NO_CLIENTE[noCliente].toLowerCase()}). No es un lead.`,
        };
      }
      // Tampoco quien solo mandó el mensaje automático del anuncio o saludos
      // (hallazgo de Codex): todavía no dijo qué quiere. Un «ok» sí cuenta: es
      // la respuesta a «¿avanzamos?».
      if (convId) {
        const suyos = await db
          .all<{ content: string }>(
            "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 60",
            [convId],
          )
          .catch(() => null);
        if (suyos && !escribioAlgoPropio(suyos.map((m) => m.content))) {
          return {
            leadId: null,
            message: "No se anotó: solo mandó el mensaje automático del anuncio o un saludo. Pregúntale qué necesita antes de anotarlo.",
          };
        }
      }
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

      // Si llegó desde un anuncio de WhatsApp, se le avisa a Meta: así aprende
      // qué anuncios traen interesados de verdad (src/meta/conversiones.ts).
      // Sin esperar: si Meta tarda, el cliente no espera la respuesta por eso
      // (hallazgo de Codex). avisarAMeta nunca lanza y se corta a los 8 s.
      if (convId) {
        void import("../meta/conversiones").then(({ avisarAMeta }) => avisarAMeta(env, convId, "LeadSubmitted"));
      }

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
          const previos = await db.first<{ n: number }>(
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
