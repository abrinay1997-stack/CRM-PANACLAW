// La ficha del cliente: todo lo que se sabe de una persona en una sola hoja, sin salir
// de la conversación (como en D'Casa). Se abre tocando el nombre en la cabecera del chat.
// Es solo de lectura: lo que se cambia (estado del lead, tickets) se hace en su pestaña.

import type { Env } from "../../env";
import { Db } from "../../db/client";
import { CustomerFactsRepo } from "../../db/facts";
import { channelLabel, telefonoDelCliente } from "../../channels/labels";
import { leerEtiquetas, etiquetasDe, COLORES } from "../../etiquetas";
import { esNotaInterna, textoDeNota } from "../../notas";
import { marcaNoCliente, MOTIVO_NO_CLIENTE } from "../../noCliente";
import { ico } from "./layout";
import { horaDelNegocio, mensajeParaVer, telefonoLegible } from "./mensajes";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ESTADO_LEAD: Record<string, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  won: "Vendido",
  lost: "Perdido",
};

function bloque(titulo: string, icono: string, cuerpo: string): string {
  return `
    <section style="padding:12px 0;border-top:1px solid var(--line)">
      <h3 style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600">${ico(icono, 13)} ${titulo}</h3>
      ${cuerpo}
    </section>`;
}

export async function renderFicha(env: Env, convId: string): Promise<string> {
  const db = new Db(env.DB);
  const conv = await db.first<any>("SELECT * FROM conversations WHERE id = ?", [convId]);
  if (!conv) return "";

  const [leads, tickets, mensajes, defs, hechos, primerosDelCliente] = await Promise.all([
    db.all<any>("SELECT * FROM leads WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5", [convId]),
    db.all<any>("SELECT * FROM tickets WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5", [convId]),
    db.first<{ total: number; cliente: number; ultimo: number | null }>(
      "SELECT COUNT(*) AS total, SUM(role = 'user') AS cliente, MAX(created_at) AS ultimo FROM messages WHERE conversation_id = ?",
      [convId],
    ),
    leerEtiquetas(db),
    new CustomerFactsRepo(db).forConversation(convId, 8),
    db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND content LIKE '%[ANUNCIO:%' ORDER BY created_at ASC LIMIT 1", [convId]),
  ]);
  const notas = (await db.all<{ content: string; created_at: number }>(
    "SELECT content, created_at FROM messages WHERE conversation_id = ? AND role = 'owner' AND content LIKE '[NOTA INTERNA]%' ORDER BY created_at DESC LIMIT 5",
    [convId],
  )).filter((n) => esNotaInterna(n.content));

  const nombre = esc(conv.display_name ?? conv.channel_user_id);
  const tel = telefonoDelCliente(conv.channel, conv.channel_user_id);
  const pausada = conv.paused_until && conv.paused_until > Date.now();
  const noCliente = marcaNoCliente(conv.metadata);
  const iniciales = esc((conv.display_name ?? conv.channel_user_id ?? "?").trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() ?? "").join("") || "?");
  const anuncio = primerosDelCliente[0] ? mensajeParaVer(primerosDelCliente[0].content).anuncio : null;

  const etiquetas = etiquetasDe(conv.metadata)
    .map((id) => defs.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => `<span style="font-size:13px;color:${COLORES[e.color]};border:1px solid ${COLORES[e.color]};padding:2px 10px;border-radius:999px">${esc(e.nombre)}</span>`)
    .join(" ");

  const cuerpoLeads = leads.length
    ? leads
        .map(
          (l) => `<div style="margin-bottom:8px;font-size:14px;line-height:1.45">
            <div><b>${esc(l.name ?? "Sin nombre")}</b> · <span style="color:var(--accent-2)">${esc(ESTADO_LEAD[l.status] ?? l.status ?? "")}</span></div>
            ${l.contact ? `<div style="color:var(--muted)">${esc(l.contact)}</div>` : ""}
            ${l.intent ? `<div>${esc(String(l.intent).slice(0, 200))}</div>` : ""}
            ${l.notes ? `<div style="color:var(--muted)">${esc(String(l.notes).slice(0, 200))}</div>` : ""}
          </div>`,
        )
        .join("")
    : `<div style="font-size:14px;color:var(--dim)">Todavía no es un lead.</div>`;

  const cuerpoTickets = tickets.length
    ? tickets
        .map(
          (t) => `<div style="margin-bottom:6px;font-size:14px;line-height:1.4"><span style="color:${t.status === "resolved" ? "var(--ok)" : "var(--accent-2)"}">${t.status === "resolved" ? "Resuelto" : "Abierto"}</span> · ${esc(String(t.summary).slice(0, 160))}</div>`,
        )
        .join("")
    : `<div style="font-size:14px;color:var(--dim)">Sin tickets.</div>`;

  return `
  <div id="ficha-hoja" role="dialog" aria-modal="true" aria-label="Ficha de ${nombre}" style="position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;align-items:flex-end">
    <div onclick="window.cerrarFicha()" style="position:absolute;inset:0;background:rgba(0,0,0,.5)"></div>
    <div class="ficha-panel" style="position:relative;width:min(420px,100%);max-height:88vh;overflow-y:auto;background:var(--panel);border:1px solid var(--linelit);border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom))">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div aria-hidden="true" style="width:48px;height:48px;flex:none;border-radius:50%;background:var(--raise);border:1px solid var(--linelit);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--accent)">${iniciales}</div>
        <div style="min-width:0;flex:1">
          <div style="font-family:var(--font-display);font-weight:700;font-size:18px;overflow-wrap:anywhere">${nombre}</div>
          <div style="font-size:13px;color:var(--muted)">${esc([tel ? telefonoLegible(tel) : null, channelLabel(conv.channel)].filter(Boolean).join(" · "))}</div>
        </div>
        <button type="button" class="tap" onclick="window.cerrarFicha()" aria-label="Cerrar la ficha" style="width:44px;height:44px;flex:none;border:none;background:none;color:var(--muted);cursor:pointer;font-size:22px;border-radius:11px">${ico("x", 20)}</button>
      </div>
      ${etiquetas ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px">${etiquetas}</div>` : ""}
      <div style="font-size:14px;line-height:1.6">
        <div>${pausada ? "Atiende una persona" : "Atiende el bot"}${noCliente ? ` · <span style="color:var(--muted)">No es cliente (${esc(MOTIVO_NO_CLIENTE[noCliente])})</span>` : ""}</div>
        <div style="color:var(--muted)">Primer contacto: ${esc(horaDelNegocio(env, conv.started_at, true))}</div>
        <div style="color:var(--muted)">${mensajes?.total ?? 0} mensajes (${mensajes?.cliente ?? 0} del cliente)${mensajes?.ultimo ? ` · último ${esc(horaDelNegocio(env, mensajes.ultimo))}` : ""}</div>
        ${anuncio ? `<div style="color:var(--muted)">${ico("megaphone", 13)} Llegó desde el anuncio «${esc(anuncio)}»</div>` : ""}
      </div>
      ${bloque("Lead", "banknote", cuerpoLeads)}
      ${bloque("Tickets", "bell", cuerpoTickets)}
      ${bloque("Lo que el bot sabe", "brain", hechos.length ? `<ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.5">${hechos.map((h) => `<li>${esc(h.fact)}</li>`).join("")}</ul>` : `<div style="font-size:14px;color:var(--dim)">Todavía no ha guardado datos de esta persona.</div>`)}
      ${notas.length ? bloque("Notas internas", "lock", notas.map((n) => `<div style="margin-bottom:8px;font-size:14px;line-height:1.45;white-space:pre-wrap">${esc(textoDeNota(n.content))}<div style="font-size:12px;color:var(--dim)">${esc(horaDelNegocio(env, n.created_at))}</div></div>`).join("")) : ""}
      <div style="padding-top:12px;border-top:1px solid var(--line);display:flex;gap:8px;flex-wrap:wrap">
        <a href="/admin/leads" class="chip tap" style="font-size:14px;padding:0 14px;min-height:44px;display:inline-flex;align-items:center;border:1px solid var(--linelit);color:var(--cream)">Ver en Leads</a>
        <a href="/admin/tickets" class="chip tap" style="font-size:14px;padding:0 14px;min-height:44px;display:inline-flex;align-items:center;border:1px solid var(--linelit);color:var(--cream)">Ver Tickets</a>
      </div>
    </div>
  </div>`;
}
