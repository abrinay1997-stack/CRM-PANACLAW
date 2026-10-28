// Los contactos en una hoja de cálculo: todos los que escribieron, con su
// teléfono, cuándo llegaron, si vinieron de un anuncio y en qué quedó su lead.
// Distinto de «Exportar CSV» en Leads, que solo trae a quien el bot anotó como
// interesado: aquí está también quien escribió y no compró.
import type { Env } from "../../env";
import { Db } from "../../db/client";
import { channelLabel, telefonoDelCliente } from "../../channels/labels";
import { horaDelNegocio, telefonoLegible } from "./mensajes";

const ESTADO_DEL_LEAD: Record<string, string> = {
  new: "nuevo",
  contacted: "contactado",
  sold: "vendido",
  lost: "perdido",
};

const celda = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function exportarContactosCsv(env: Env): Promise<string> {
  const filas = await new Db(env.DB).all<{
    display_name: string | null;
    channel: string;
    channel_user_id: string;
    started_at: number;
    last_message_at: number;
    mensajes: number;
    anuncio: number;
    lead_status: string | null;
    lead_nombre: string | null;
    lead_contacto: string | null;
    lead_intent: string | null;
  }>(
    `SELECT c.display_name, c.channel, c.channel_user_id, c.started_at, c.last_message_at,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS mensajes,
       EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND instr(m.content, '[ANUNCIO:') > 0) AS anuncio,
       (SELECT status FROM leads l WHERE l.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS lead_status,
       (SELECT name FROM leads l WHERE l.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS lead_nombre,
       (SELECT contact FROM leads l WHERE l.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS lead_contacto,
       (SELECT intent FROM leads l WHERE l.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS lead_intent
     FROM conversations c
     ORDER BY c.last_message_at DESC`,
  );

  const cabecera = [
    "nombre",
    "telefono",
    "canal",
    "primer_mensaje",
    "ultimo_mensaje",
    "mensajes_del_cliente",
    "vino_de_un_anuncio",
    "lead",
    "nombre_en_el_lead",
    "contacto_en_el_lead",
    "que_busca",
  ].join(",");
  const lineas = filas.map((f) => {
    const tel = telefonoDelCliente(f.channel, f.channel_user_id);
    return [
      celda(f.display_name ?? ""),
      celda(tel ? telefonoLegible(tel) : ""),
      celda(channelLabel(f.channel)),
      celda(horaDelNegocio(env, f.started_at, true)),
      celda(horaDelNegocio(env, f.last_message_at, true)),
      celda(f.mensajes),
      celda(f.anuncio ? "sí" : "no"),
      celda(f.lead_status ? (ESTADO_DEL_LEAD[f.lead_status] ?? f.lead_status) : ""),
      celda(f.lead_nombre),
      celda(f.lead_contacto),
      celda(f.lead_intent),
    ].join(",");
  });
  // Con BOM: sin él, Excel abre el archivo como Latin-1 y las tildes salen rotas.
  return `﻿${cabecera}\n${lineas.join("\n")}\n`;
}
