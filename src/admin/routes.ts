/**
 * Admin dashboard routes (Hono sub-app mounted at `/admin`).
 *
 * El acceso sigue siendo **una sola contraseña**, la de siempre, en el secreto
 * `DASHBOARD_PASSWORD`. Lo que cambió es la puerta: antes la dibujaba el
 * navegador (Basic Auth) y no se podía diseñar; ahora hay una pantalla propia
 * en `/admin/login` que deja una cookie firmada (ver `session.ts`).
 *
 * `Authorization: Basic` se conserva como acceso de emergencia, y
 * `DASHBOARD_PUBLIC="1"` sigue dejando el panel abierto. No hay usuarios, ni
 * roles, ni correos: nada nuevo que configurar en Cloudflare.
 */
import { parsePeerBots } from "./projects";
import { Hono } from "hono";
import { generateText } from "ai";
import { recordAiUsage, usageFromSdk } from "../db/aiUsage";
import {
  createModel,
  pareceLlaveDeIa,
  proveedorDelModelo,
  MAX_TOKENS_DE_PRUEBA,
  PROVEEDORES,
  type LlmProvider,
} from "../llm/provider";
import { loadLlmOverrides, contextoDelNegocio } from "../settings-loader";
import { parseBusinessHours, formatBusinessHours } from "../hours";
import type { Env } from "../env";
import { checkBasicCredentials, timingSafeEqual } from "./auth";
import {
  createSession,
  verifySession,
  readSessionCookie,
  sessionCookieHeader,
  clearSessionCookieHeader,
} from "./session";
import { layout, renderUpgrade, loginPage } from "./views/layout";
import { isPro } from "../config";
import { renderOverview } from "./views/overview";
import { renderStats } from "./views/stats";
import { renderCosts } from "./views/costs";
import {
  renderInbox,
  renderInboxList,
  renderThreadLive,
  renderSuggestionBox,
} from "./views/conversations";
import { pickAdapter } from "../replies/sender";
import { channelLabel } from "../channels/labels";
import type { ChannelId } from "../channels/shared";
import { renderInsights } from "./views/insights";
import { analyzeConversations } from "../insights/analyzer";
import { renderAgentePage, renderAgenteCanvas, renderNodeModal, toggleTool, toastOob } from "./views/agente";
import { renderKbList, renderKbEditor } from "./views/kb";
import { KbDocsRepo, indexDoc, removeDocVectors, reindexAll, MAX_DOC_CHARS } from "../kb/docs";
import { renderMejoras } from "./views/mejoras";
import { runFlywheel, getLessons, saveLessons } from "../flywheel/detect";
import { applySuggestion, dismissSuggestion } from "../flywheel/apply";
import { renderLeads, exportLeadsCsv } from "./views/leads";
import { exportarContactosCsv } from "./views/contactos";
import { conversacionEnTexto } from "./views/mensajes";
import { adjuntosDe, borrarAdjuntosDe, servirAdjunto, guardarAdjunto, marcaDeAdjunto } from "../media/adjuntos";
import { MEDIA_MAXIMA } from "../media/almacen";
import { enviarArchivo } from "../channels/archivos";
import { avisarAMeta, estadoMeta, ultimoClic, montoDe, borrarEventosDe } from "../meta/conversiones";
import { renderTickets } from "./views/tickets";
import { renderConfig, CONSERVAR } from "./views/config";
import { renderConexiones } from "./views/conexiones";
import { pausarPorHumano, devolverAlBot } from "../takeover";
import { chatDelDueno, crearCodigoDeVinculo, desvincular, protegerConsola } from "../owner/dueno";
import { nombreDelBot } from "../owner/telegram";
import { avisarAlDueno } from "../owner/avisos";
import {
  renderAvisoDuenoEnlace,
  renderAvisoDuenoSinVincular,
  renderAvisoDuenoVinculado,
} from "./views/avisoDueno";
import { renderWhatsappQrPanel, type EstadoDelPuente } from "./views/whatsappQr";
import { renderCampanas } from "./views/campanas";
import { sendCampaign, createHandoffTemplate, contentApprovalStatus } from "../campaigns";
import { Db } from "../db/client";
import { LeadsRepo, type Lead } from "../db/leads";
import { TicketsRepo } from "../db/tickets";
import { ConversationsRepo } from "../db/conversations";
import { MessagesRepo } from "../db/messages";
import { SettingsRepo, SETTING_KEYS, type SettingKey } from "../db/settings";
import { CONTROLS, levelToValue } from "./control-levels";
import { systemPromptFromEnv } from "../system-prompt";

export const adminApp = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Entrada al panel
//
// Estas tres rutas van OBLIGATORIAMENTE antes del guard de abajo. Si quedaran
// detrás, pedir /admin/login sin sesión dispararía la redirección a
// /admin/login, que volvería a dispararla: bucle infinito.
// ---------------------------------------------------------------------------

adminApp.get("/login", async (c) => {
  // Si ya hay sesión válida no tiene sentido mostrar el formulario.
  const cookie = readSessionCookie(c.req.header("cookie"));
  if (await verifySession(c.env.DASHBOARD_PASSWORD, cookie)) {
    return c.redirect("/admin/overview", 302);
  }
  return c.html(loginPage(c.env));
});

adminApp.post("/login", async (c) => {
  const form = await c.req.formData();
  const password = String(form.get("password") ?? "");
  const expected = c.env.DASHBOARD_PASSWORD ?? "";

  // Sin contraseña configurada no se puede entrar por aquí: fallar cerrado.
  if (!expected || !timingSafeEqual(password, expected)) {
    return c.html(loginPage(c.env, "Esa contraseña no es. Revisa e intenta de nuevo."), 401);
  }

  const value = await createSession(expected);
  c.header("Set-Cookie", sessionCookieHeader(value, c.req.url));
  return c.redirect("/admin/overview", 302);
});

adminApp.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookieHeader(c.req.url));
  return c.redirect("/admin/login", 302);
});

// ---------------------------------------------------------------------------
// Guard. Cascada, en este orden:
//
//   1. DASHBOARD_PUBLIC="1" → pasa. Es una decisión deliberada de instancia
//      (wrangler.toml) que deja el panel público; se respeta igual que antes.
//   2. Cookie de sesión válida → pasa. Es el camino normal desde que existe la
//      pantalla de entrada.
//   3. Authorization: Basic correcto → pasa. Se conserva como acceso de
//      emergencia: si algo sale mal con la cookie, todavía se puede entrar por
//      el método viejo sin quedarse fuera del panel. Cuesta tres líneas.
//   4. Nada de lo anterior → a la pantalla de entrada.
//
// Ojo: el paso 4 redirige en vez de responder 401, así que el navegador ya no
// dibuja su ventana gris. Esa es justamente la razón de todo esto.
// ---------------------------------------------------------------------------
adminApp.use("*", async (c, next) => {
  if (c.env.DASHBOARD_PUBLIC === "1") return next();

  const cookie = readSessionCookie(c.req.header("cookie"));
  if (await verifySession(c.env.DASHBOARD_PASSWORD, cookie)) return next();

  if (checkBasicCredentials(c.req.header("authorization"), c.env)) return next();

  return c.redirect("/admin/login", 302);
});

// Gate de tier: el panel free ve el nav Pro bloqueado; si aun así navega a una
// ruta Pro (URL directa, bookmark, click al item bloqueado), servimos la página
// de upgrade en vez de la vista real. Los datos Pro nunca se exponen en free.
const PRO_GATE: Array<[string, string]> = [
  ["/admin/insights", "Insights"],
  ["/admin/stats", "Estadísticas"],
  ["/admin/costs", "Costos"],
  ["/admin/mejoras", "Mejoras"],
  ["/admin/campanas", "Campañas"],
];
adminApp.use("*", async (c, next) => {
  if (isPro(c.env)) return next();
  const path = c.req.path;
  const hit = PRO_GATE.find(([pre]) => path === pre || path.startsWith(pre + "/"));
  if (hit) return c.html(renderUpgrade(c.env, hit[1]));
  return next();
});

// Página de upgrade (item bloqueado del nav apunta aquí).
adminApp.get("/upgrade", (c) => c.html(renderUpgrade(c.env)));

// Root → default tab.
adminApp.get("/", (c) => c.redirect("/admin/overview"));

// Selector de proyectos (header): instancia actual + hermanas de PEER_BOTS.
adminApp.get("/projects", (c) =>
  c.json({ current: c.env.BOT_NAME ?? "Mi bot", peers: parsePeerBots(c.env) }),
);

// --- Read-only tabs ---------------------------------------------------------

adminApp.get("/overview", async (c) => c.html(await renderOverview(c.env)));

adminApp.get("/stats", async (c) => c.html(await renderStats(c.env)));

adminApp.get("/costs", async (c) => c.html(await renderCosts(c.env, c.req.query("saved") === "1")));

// Monthly AI budget (Costos tab). Empty value clears the cap.
adminApp.post("/costs/budget", async (c) => {
  const form = await c.req.formData();
  const raw = String(form.get("monthly_budget") ?? "").trim();
  const n = Number.parseFloat(raw);
  const value = raw !== "" && Number.isFinite(n) && n > 0 ? String(n) : "";
  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.monthlyBudget, value);
  return c.redirect("/admin/costs?saved=1");
});

// --- Conocimiento (KB editable, F4) -------------------------------------------

adminApp.get("/kb", async (c) =>
  c.html(
    await renderKbList(c.env, {
      saved: c.req.query("saved") === "1",
      deleted: c.req.query("deleted") === "1",
      reindexed: c.req.query("reindexed") ?? undefined,
    }),
  ),
);

adminApp.get("/kb/new", (c) => c.html(renderKbEditor(null, c.env)));

adminApp.get("/kb/:id/edit", async (c) => {
  const doc = await new KbDocsRepo(new Db(c.env.DB)).getById(c.req.param("id"));
  if (!doc) return c.redirect("/admin/kb");
  return c.html(renderKbEditor(doc, c.env));
});

// Save = persist in D1 + index into Vectorize immediately (stale vectors for
// the doc are blanket-deleted first), so searchKb uses it on the next message.
adminApp.post("/kb/save", async (c) => {
  const form = await c.req.formData();
  const title = String(form.get("title") ?? "").trim().slice(0, 200);
  const content = String(form.get("content") ?? "").trim().slice(0, MAX_DOC_CHARS);
  if (!title || !content) return c.redirect("/admin/kb");

  const id = String(form.get("id") ?? "").trim() || crypto.randomUUID();
  const repo = new KbDocsRepo(new Db(c.env.DB));
  await repo.upsert({ id, title, content });
  const doc = (await repo.getById(id))!;
  await indexDoc(c.env, doc);
  return c.redirect("/admin/kb?saved=1");
});

adminApp.post("/kb/:id/delete", async (c) => {
  const id = c.req.param("id");
  await new KbDocsRepo(new Db(c.env.DB)).delete(id);
  await removeDocVectors(c.env, id);
  return c.redirect("/admin/kb?deleted=1");
});

// Reindex general: el índice queda igual a los documentos del panel.
adminApp.post("/kb/reindex", async (c) => {
  const r = await reindexAll(c.env);
  return c.redirect(`/admin/kb?reindexed=${r.indexed}`);
});

// --- Aviso al dueño por Telegram (vincular sin terminal) -----------------------
//
// El fragmento vive en la tarjeta de Telegram de Conexiones. `esperando=1` es
// el sondeo mientras la dueña abre el enlace: contesta 204 (htmx no toca nada)
// hasta que el vínculo existe, y entonces pinta el verde.
adminApp.get("/telegram/dueno", async (c) => {
  const chat = await chatDelDueno(c.env);
  if (chat) {
    return c.html(renderAvisoDuenoVinculado({ chatId: chat, porSecret: !!c.env.OWNER_TELEGRAM_CHAT_ID?.trim() }));
  }
  if (c.req.query("esperando")) return c.body(null, 204);
  return c.html(renderAvisoDuenoSinVincular());
});

adminApp.post("/telegram/vincular", async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) return c.html(renderAvisoDuenoSinVincular("Falta el token del bot de Telegram."));
  // Primero se protege el webhook: la consola solo obedece updates firmados
  // por Telegram, y el código que la dueña va a mandar tiene que llegar firmado.
  const webhook = await protegerConsola(c.env);
  if (!webhook.ok) return c.html(renderAvisoDuenoSinVincular(webhook.error));
  const { codigo } = await crearCodigoDeVinculo(c.env);
  return c.html(renderAvisoDuenoEnlace({ bot: await nombreDelBot(c.env), codigo }));
});

adminApp.post("/telegram/prueba", async (c) => {
  const chat = await chatDelDueno(c.env);
  if (!chat) return c.html(renderAvisoDuenoSinVincular());
  // También protege el webhook: un dueño vinculado por el secret
  // OWNER_TELEGRAM_CHAT_ID nunca pasó por "Vincular", y sin la firma la
  // consola no le obedece.
  await protegerConsola(c.env);
  const ok = await avisarAlDueno(c.env, {
    titulo: "🔔 Aviso de prueba",
    cuerpo: "Así te van a llegar los avisos del bot. Escribe /ayuda para ver lo que puedes hacer desde aquí.",
    conBotones: false,
  });
  return c.html(
    renderAvisoDuenoVinculado({
      chatId: chat,
      porSecret: !!c.env.OWNER_TELEGRAM_CHAT_ID?.trim(),
      resultado: ok
        ? "✓ Enviado. Revisa tu Telegram."
        : "✕ Telegram no lo aceptó. Abre el bot en Telegram y toca Iniciar (un bot no puede escribirle a quien nunca le habló).",
    }),
  );
});

adminApp.post("/telegram/desvincular", async (c) => {
  await desvincular(c.env);
  return c.html(renderAvisoDuenoSinVincular());
});

// --- Handoff: plantilla HSM del aviso al dueño ---------------------------------

// Setup one-shot: crea la plantilla en la Content API de Twilio, la somete a
// aprobación de WhatsApp (UTILITY) y guarda el ContentSid en settings —
// notifyOwner la usa como fallback del secret, sin pasos manuales.
adminApp.post("/handoff/template/setup", async (c) => {
  const r = await createHandoffTemplate(c.env);
  if ("error" in r) return c.json(r, 502);
  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.twilioHandoffContentSid, r.sid);
  return c.json(r);
});

// Estado de aprobación de la plantilla del handoff (approved | pending | …).
adminApp.get("/handoff/template/status", async (c) => {
  const sid =
    c.env.TWILIO_HANDOFF_CONTENT_SID ||
    (await new SettingsRepo(new Db(c.env.DB)).get(SETTING_KEYS.twilioHandoffContentSid));
  if (!sid) return c.json({ error: "sin plantilla — corre el setup primero" }, 404);
  const r = await contentApprovalStatus(c.env, sid);
  return c.json({ sid, ...r });
});

// --- Mejoras (flywheel, F5) ----------------------------------------------------

adminApp.get("/mejoras", async (c) =>
  c.html(
    await renderMejoras(c.env, {
      found: c.req.query("found") ?? undefined,
      applied: c.req.query("applied") === "1",
      dismissed: c.req.query("dismissed") === "1",
    }),
  ),
);

// Run the detectors on demand (they also run nightly from scheduled()).
adminApp.post("/mejoras/run", async (c) => {
  const r = await runFlywheel(c.env);
  return c.redirect(`/admin/mejoras?found=${r.created}`);
});

adminApp.post("/mejoras/:id/apply", async (c) => {
  const ok = await applySuggestion(c.env, c.req.param("id"));
  return c.redirect(ok ? "/admin/mejoras?applied=1" : "/admin/mejoras");
});

adminApp.post("/mejoras/:id/dismiss", async (c) => {
  const ok = await dismissSuggestion(c.env, c.req.param("id"));
  return c.redirect(ok ? "/admin/mejoras?dismissed=1" : "/admin/mejoras");
});

// Autonomía del flywheel: manual (default) o copiloto (auto-aplica lo seguro
// en el cron nocturno — KB sin huecos y lecciones; lo delicado sigue en cola).
adminApp.post("/mejoras/autonomy", async (c) => {
  const form = await c.req.formData();
  const level = String(form.get("level") ?? "manual") === "copilot" ? "copilot" : "manual";
  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.autonomyLevel, level);
  return c.redirect("/admin/mejoras");
});

// Remove one lesson from the prompt (the ✕ next to each active lesson).
adminApp.post("/mejoras/lessons/remove", async (c) => {
  const form = await c.req.formData();
  const lesson = String(form.get("lesson") ?? "");
  const lessons = (await getLessons(c.env)).filter((l) => l !== lesson);
  await saveLessons(c.env, lessons);
  return c.redirect("/admin/mejoras");
});

// Inbox (F1): two-pane view. ?c=<id> selects the thread; ?f/?q filter the list.
adminApp.get("/conversations", async (c) =>
  c.html(
    await renderInbox(c.env, {
      search: c.req.query("q"),
      filter: c.req.query("f"),
      selectedId: c.req.query("c"),
      deleted: c.req.query("deleted"),
    }),
  ),
);

// HTMX fragments (polled): left list every 10s, thread every 5s. Registered
// before /conversations/:id so the static segments win the match.
adminApp.get("/conversations/list-fragment", async (c) =>
  c.html(
    await renderInboxList(c.env, {
      search: c.req.query("q"),
      filter: c.req.query("f"),
      selectedId: c.req.query("c"),
    }),
  ),
);

adminApp.get("/conversations/thread/:id", async (c) =>
  c.html(await renderThreadLive(c.env, c.req.param("id"))),
);

// Old detail URLs (linked from Insights, notifications, etc.) → inbox selection.
adminApp.get("/conversations/:id", (c) =>
  c.redirect(`/admin/conversations?c=${encodeURIComponent(c.req.param("id"))}`),
);

// Insights tab. Visiting it opportunistically grades a few pending
// conversations in the background (waitUntil) so the tab catches up on its own
// even without pressing "Analizar ahora". TODO: move the main run to
// scheduled() in index.ts once the channels/meta work in flight there lands.
adminApp.get("/insights", async (c) => {
  try {
    c.executionCtx.waitUntil(
      analyzeConversations(c.env, { limit: 3 }).catch((e) =>
        console.error("[insights] background analysis failed:", e),
      ),
    );
  } catch {
    // no executionCtx (tests) — render without background catch-up
  }
  return c.html(await renderInsights(c.env, c.req.query("analyzed") ?? undefined));
});

// "Analizar ahora": grade up to 10 pending conversations inline, then redirect
// back with the count for the confirmation banner.
adminApp.post("/insights/analyze", async (c) => {
  const result = await analyzeConversations(c.env, { limit: 10 });
  return c.redirect(`/admin/insights?analyzed=${result.analyzed}`);
});

// "Mi Agente": n8n-style canvas of how the bot works. The canvas fragment is
// polled by HTMX every 15s (live activity pulse); node panels load on click.
adminApp.get("/agente", async (c) => c.html(await renderAgentePage(c.env)));

adminApp.get("/agente/canvas", async (c) => c.html(await renderAgenteCanvas(c.env)));

adminApp.get("/agente/node/:id", async (c) =>
  c.html(await renderNodeModal(c.env, c.req.param("id"))),
);

// Save a node's config from its modal. Writes the relevant settings (with
// clamps), re-renders the modal with a saved banner + toast, and fires the
// `canvas-refresh` event so the diagram updates immediately.
adminApp.post("/agente/node/:id/save", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.formData();
  const repo = new SettingsRepo(new Db(c.env.DB));

  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
  const num = (key: string): number | null => {
    const raw = form.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  if (id === "buffer") {
    const s = num("buffer_seconds");
    if (s !== null) await repo.set(SETTING_KEYS.bufferSeconds, String(Math.round(clamp(s, 1, 60))));
  } else if (id === "reply") {
    const chunks = num("max_chunks");
    if (chunks !== null) await repo.set(SETTING_KEYS.maxChunks, String(Math.round(clamp(chunks, 1, 5))));
    const delayS = num("inter_chunk_delay_s");
    if (delayS !== null)
      await repo.set(SETTING_KEYS.interChunkDelayMs, String(Math.round(clamp(delayS, 0, 5) * 1000)));
  } else if (id === "model") {
    const m = String(form.get("model_override") ?? "");
    if (m === "auto" || m === "haiku" || m === "sonnet") await repo.set(SETTING_KEYS.modelOverride, m);
    const t = num("temperature");
    if (t !== null) await repo.set(SETTING_KEYS.temperature, String(clamp(t, 0, 1)));
  } else if (id === "brain") {
    // Three sub-actions share the brain modal: reset-to-auto, pause toggle,
    // and saving the manual prompt. Checked in that priority order.
    if (String(form.get("action") ?? "") === "reset") {
      await repo.set(SETTING_KEYS.systemPromptOverride, "");
    } else if (form.get("bot_paused") !== null) {
      await repo.set(SETTING_KEYS.botPaused, String(form.get("bot_paused")) === "1" ? "1" : "0");
    } else if (form.get("system_prompt_override") !== null) {
      await repo.set(SETTING_KEYS.systemPromptOverride, String(form.get("system_prompt_override")).trim());
    }
  } else {
    return c.text("Nodo desconocido", 404);
  }

  c.header("HX-Trigger", "canvas-refresh");
  return c.html((await renderNodeModal(c.env, id, true)) + toastOob("✓ Guardado"));
});

// Toggle a tool on/off (settings.disabled_tools). Returns the refreshed modal;
// the canvas badge updates via the canvas-refresh event.
adminApp.post("/agente/tools/:name/toggle", async (c) => {
  const name = c.req.param("name");
  const ok = await toggleTool(c.env, name);
  if (!ok) return c.text("Tool no encontrada", 404);
  c.header("HX-Trigger", "canvas-refresh");
  return c.html((await renderNodeModal(c.env, `tool:${name}`, true)) + toastOob("✓ Guardado"));
});

adminApp.get("/leads", async (c) => c.html(await renderLeads(c.env)));

adminApp.get("/tickets", async (c) => c.html(await renderTickets(c.env)));

// Conexiones: mapa de canales con estado verde/gris (paso 4 del onboarding).
adminApp.get("/conexiones", (c) => c.html(renderConexiones(c.env)));

// --- WhatsApp por QR --------------------------------------------------------
//
// El panel no habla con WhatsApp: habla con el puente `panaclaw-wa`, que es
// quien sostiene el socket. Estas tres rutas son un proxy fino con una sola
// responsabilidad añadida: que el token del puente NUNCA salga hacia el
// navegador. Si el panel pidiera el estado desde el cliente, el token viajaría
// en el HTML y cualquiera con el panel abierto podría vincular otro teléfono.

/** El token, en base64: una cabecera HTTP no entrega intacto un valor no-ASCII. */
function tokenB64(token: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(token)));
}

async function llamarAlPuente(
  env: Env,
  ruta: string,
  init: RequestInit = {},
): Promise<{ respuesta: Response | null; motivo: string | null }> {
  if (!env.WA_TOKEN) return { respuesta: null, motivo: "falta WA_TOKEN" };
  if (!env.PUENTE_WA && !env.WA_PUENTE_URL) {
    return { respuesta: null, motivo: "falta el binding PUENTE_WA o WA_PUENTE_URL" };
  }
  try {
    // Por SERVICE BINDING cuando existe. Cloudflare rechaza con error 1042 que
    // un Worker llame a otro Worker de la MISMA cuenta por su URL pública: la
    // petición ni siquiera llega a la puerta del otro, y el síntoma es un 404
    // que parece "la ruta no existe". Con binding el host da igual; lo que
    // cuenta es la ruta.
    const destino = env.PUENTE_WA
      ? `https://puente-wa${ruta}`
      : `${env.WA_PUENTE_URL!.replace(/\/$/, "")}${ruta}`;
    const peticion = new Request(destino, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-wa-token-b64": tokenB64(env.WA_TOKEN) },
      // 15 s, no 8: el puente reintenta hasta 12,5 s cuando el contenedor está
      // frío. Con un tope más corto que el del otro lado, el panel se rendía
      // antes de que llegara la respuesta y mostraba un error que no existía.
      signal: AbortSignal.timeout(15000),
    });
    const respuesta = env.PUENTE_WA ? await env.PUENTE_WA.fetch(peticion) : await fetch(peticion);
    if (!respuesta.ok) {
      // El motivo se muestra en pantalla. Un 401 y un 502 piden cosas muy
      // distintas, y "no se pudo" no distingue ninguna de las dos.
      //
      // Va también un trozo del CUERPO, porque el código solo no basta para
      // saber QUIÉN contestó: un 404 del puente dice {"error":"no existe"} y
      // uno de otro sitio dice cualquier otra cosa. Sin eso no se puede
      // distinguir "la ruta no existe" de "la petición ni siquiera llegó".
      const cuerpo = await respuesta
        .text()
        .then((t) => t.replace(/\s+/g, " ").slice(0, 160))
        .catch(() => "");
      return {
        respuesta: null,
        motivo: `el puente respondió ${respuesta.status}${cuerpo ? ` · ${cuerpo}` : ""}`,
      };
    }
    return { respuesta, motivo: null };
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    console.error("puente-wa:", e);
    return { respuesta: null, motivo };
  }
}

/** Fragmento que htmx recarga cada 5 s dentro de la tarjeta de Conexiones. */
adminApp.get("/whatsapp-qr/estado", async (c) => {
  const [rEstado, rQr] = await Promise.all([
    llamarAlPuente(c.env, "/api/estado"),
    llamarAlPuente(c.env, "/api/qr"),
  ]);

  const estado = rEstado.respuesta
    ? ((await rEstado.respuesta.json()) as EstadoDelPuente)
    : ({ error: rEstado.motivo ?? "sin respuesta" } as EstadoDelPuente);
  const qr = rQr.respuesta
    ? (((await rQr.respuesta.json()) as { qr?: string | null }).qr ?? null)
    : null;

  return c.html(renderWhatsappQrPanel(estado, qr));
});

adminApp.post("/whatsapp-qr/reiniciar", async (c) => {
  await llamarAlPuente(c.env, "/api/reiniciar", { method: "POST" });
  // Se devuelve el fragmento con el estado nuevo, no un mensaje: el dueño ve la
  // consecuencia de lo que acaba de tocar, no una confirmación que hay que creer.
  return c.html(
    renderWhatsappQrPanel(
      { contenedor: { conexion: "arrancando" } },
      null,
    ),
  );
});

adminApp.post("/whatsapp-qr/desvincular", async (c) => {
  await llamarAlPuente(c.env, "/api/desvincular", { method: "POST" });
  return c.html(renderWhatsappQrPanel({ contenedor: { conexion: "desvinculada" } }, null));
});

adminApp.get("/campanas", async (c) => {
  const q: Record<string, string | undefined> = {
    ok: c.req.query("ok"),
    err: c.req.query("err"),
    ff: c.req.query("ff"),
    tp: c.req.query("tp"),
    dup: c.req.query("dup"),
    quota: c.req.query("quota"),
    fail: c.req.query("fail"),
  };
  return c.html(await renderCampanas(c.env, q));
});

adminApp.post("/campanas/send", async (c) => {
  const form = await c.req.formData();
  const segmentId = String(form.get("segment") ?? "");
  const campaignKey = String(form.get("campaign_key") ?? "").trim();
  const freeformText = String(form.get("freeform_text") ?? "").trim();
  const templateSid = String(form.get("template_sid") ?? "").trim();
  const varsRaw = String(form.get("template_vars") ?? "").trim();
  if (!segmentId || !campaignKey || (!freeformText && !templateSid)) {
    return c.redirect("/admin/campanas?err=" + encodeURIComponent("Falta el segmento, el nombre de campaña, o un mensaje/plantilla."));
  }
  let variables: Record<string, string> | undefined;
  if (varsRaw) {
    try {
      variables = JSON.parse(varsRaw);
    } catch {
      return c.redirect("/admin/campanas?err=" + encodeURIComponent("Las variables no son JSON válido."));
    }
  }
  // El body de la plantilla viaja al historial de cada conversación — sin él,
  // el agente no sabría qué se le preguntó al cliente cuando responda.
  let templateBody: string | undefined;
  if (templateSid) {
    const { listContentTemplates } = await import("../campaigns");
    const tpl = (await listContentTemplates(c.env).catch(() => [])).find((t) => t.sid === templateSid);
    templateBody = tpl?.body || undefined;
  }
  const result = await sendCampaign(c.env, {
    segmentId,
    campaignKey,
    freeformText: freeformText || undefined,
    template: templateSid ? { sid: templateSid, variables, body: templateBody } : undefined,
  });
  const q = new URLSearchParams({
    ok: "1",
    ff: String(result.sentFreeform),
    tp: String(result.sentTemplate),
    dup: String(result.skippedDuplicate),
    quota: String(result.skippedQuota),
    fail: String(result.failed),
  });
  return c.redirect("/admin/campanas?" + q.toString());
});

adminApp.get("/config", async (c) => {
  // Siembra la Información del negocio si el panel nunca la tuvo, para que el
  // dueño vea y edite aquí exactamente lo que lee el bot.
  await contextoDelNegocio(c.env);
  const settings = await new SettingsRepo(new Db(c.env.DB)).all();
  const saved = c.req.query("saved") === "1";
  const meta = await estadoMeta(c.env).catch(() => null);
  return c.html(renderConfig(c.env, settings, saved, c.req.query("llmtest"), meta));
});

// Manda un lead de prueba a Meta con el código de «Probar eventos» del
// Administrador de eventos y el último clic que llegó por un anuncio. El
// resultado queda como el último aviso, que Configuración enseña.
adminApp.post("/meta/probar", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const codigo = String(form?.get("meta_codigo_prueba") ?? "").trim();
  const dataset = String(form?.get(SETTING_KEYS.metaDatasetId) ?? "").trim();
  const repo = new SettingsRepo(new Db(c.env.DB));
  if (dataset) await repo.set(SETTING_KEYS.metaDatasetId, dataset);
  const clic = await ultimoClic(c.env);
  const detalle = !codigo
    ? "Pega primero el código de prueba (TEST…) del Administrador de eventos."
    : !clic
      ? "Todavía no ha llegado nadie por un anuncio desde que esto está activo: la prueba necesita un clic real."
      : null;
  if (detalle) {
    await repo.set(SETTING_KEYS.metaUltimoEnvio, JSON.stringify({ evento: "prueba", estado: "fallo", detalle, at: Date.now() }));
  } else {
    await avisarAMeta(c.env, "prueba", "LeadSubmitted", { prueba: { codigo, clic: clic! } });
  }
  return c.redirect("/admin/config#meta");
});

// Prueba de la config BYO-LLM guardada: un generateText mínimo con el modelo
// resuelto (settings > env). Redirige de vuelta con el resultado en la query.
adminApp.get("/config/llm-test", async (c) => {
  try {
    const ov = await loadLlmOverrides(c.env);
    const { model, modelId, provider } = createModel(c.env, "fast", ov);
    const r = await generateText({
      model,
      prompt: "Responde únicamente: ok",
      maxOutputTokens: MAX_TOKENS_DE_PRUEBA,
    });
    await recordAiUsage(new Db(c.env.DB), {
      source: "test",
      model: modelId,
      usage: usageFromSdk(r.totalUsage),
    });
    const okText = r.text.trim().slice(0, 20) || "ok";
    return c.redirect(
      `/admin/config?llmtest=${encodeURIComponent(`ok:${provider}/${modelId} → "${okText}"`)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(`/admin/config?llmtest=${encodeURIComponent(`err:${msg.slice(0, 180)}`)}`);
  }
});

// Save the control panel. Card selections are mapped from the picked option
// (value or label) back to the value we persist via `levelToValue`; free-text
// fields are stored verbatim (trimmed). Empty/absent => default at load time.
adminApp.post("/config", async (c) => {
  const form = await c.req.formData();
  const repo = new SettingsRepo(new Db(c.env.DB));

  // Card-based controls: tone, buffer_seconds, max_chunks, model_override, bot_paused.
  for (const key of Object.keys(CONTROLS)) {
    const picked = form.get(key);
    if (picked === null) continue; // control not submitted — leave as-is
    // "Personalizado": un valor que no es ninguna tarjeta. Se deja como está —
    // antes se reemplazaba por la primera tarjeta al guardar cualquier otra cosa.
    if (String(picked) === CONSERVAR) continue;
    const value = levelToValue(key, String(picked));
    if (value !== null) await repo.set(key, value);
  }

  // Un tono escrito con sus palabras le gana a la tarjeta elegida.
  const tonoLibre = String(form.get("tone_libre") ?? "").trim().slice(0, 120);
  if (tonoLibre) await repo.set(SETTING_KEYS.tone, tonoLibre);

  // Free-text controls (stored verbatim, trimmed).
  //
  // system_prompt_override YA NO se escribe desde aquí: reemplaza el prompt
  // entero y es cosa de la pestaña Agente. El campo de este formulario es
  // "Instrucciones adicionales", que se SUMAN (custom_instructions). En Baby
  // Caleb una línea escrita aquí dejó al bot sin catálogo ni contexto.
  const textKeys: SettingKey[] = [
    SETTING_KEYS.botName,
    SETTING_KEYS.customInstructions,
    SETTING_KEYS.escalationKeywords,
    SETTING_KEYS.frasesProhibidas,
    SETTING_KEYS.metaDatasetId,
  ];
  for (const key of textKeys) {
    const raw = form.get(key);
    if (raw === null) continue;
    await repo.set(key, String(raw).trim());
  }

  // La Información del negocio se guarda tal cual: es la única fuente de lo
  // que el bot sabe del negocio (ver contextoDelNegocio). Antes, si era igual
  // a la del repo, se guardaba vacía para que «mandara el repo»: eran dos
  // fuentes, y se desincronizaron.
  const contexto = form.get(SETTING_KEYS.businessContext);
  if (contexto !== null) {
    await repo.set(SETTING_KEYS.businessContext, String(contexto).replace(/\r\n/g, "\n").trim());
    await repo.set(SETTING_KEYS.contextoSembrado, "1");
  }

  /*
   * El horario laboral se normaliza antes de guardar: lo que el dueño
   * escriba se vuelve a imprimir como lo entendió el bot ("L,M,X,J,V 09:00-18:00").
   * Así el campo le devuelve lo que de verdad quedó configurado, en vez de
   * dejarle creer que "de 9 a 6 de lunes a viernes" se guardó tal cual.
   * Si no se entiende, se guarda vacío = el horario por defecto.
   */
  const hoursRaw = form.get(SETTING_KEYS.businessHours);
  if (hoursRaw !== null) {
    const parsed = parseBusinessHours(String(hoursRaw));
    await repo.set(SETTING_KEYS.businessHours, parsed ? formatBusinessHours(parsed) : "");
  }

  // BYO-LLM: proveedor y modelo se guardan tal cual (allow-list de valores).
  const provRaw = form.get(SETTING_KEYS.llmProvider);
  let proveedorElegido: LlmProvider | undefined;
  if (provRaw !== null) {
    const v = String(provRaw).trim().toLowerCase();
    proveedorElegido = (PROVEEDORES as readonly string[]).includes(v) ? (v as LlmProvider) : undefined;
    await repo.set(SETTING_KEYS.llmProvider, proveedorElegido ?? "");
  }
  const modelRaw = form.get(SETTING_KEYS.llmModel);
  const modeloElegido = modelRaw !== null ? String(modelRaw).trim().slice(0, 100) : "";
  if (modelRaw !== null) {
    await repo.set(SETTING_KEYS.llmModel, modeloElegido);
  }
  // ¿De qué proveedor tiene que ser la llave? Del elegido; si es "automático"
  // pero el modelo es de uno concreto (Muse, Grok…), de ese.
  const proveedorDeLaLlave = proveedorElegido ?? (modeloElegido ? proveedorDelModelo(modeloElegido) : undefined);
  // La API key SOLO se sobreescribe si escribieron algo (el input siempre
  // llega vacío cuando no la tocaron); el checkbox la borra explícitamente.
  if (form.get("llm_api_key_clear") === "1") {
    await repo.set(SETTING_KEYS.llmApiKey, "");
  } else {
    const keyRaw = form.get(SETTING_KEYS.llmApiKey);
    if (keyRaw !== null && String(keyRaw).trim() !== "") {
      // Solo si PARECE una llave. El navegador autocompleta los campos de
      // contraseña con la del panel: en Baby Caleb quedó guardada una
      // contraseña como llave de IA.
      const llave = String(keyRaw).trim();
      // Con Meta no hay prefijo que comprobar, así que se mira lo contrario:
      // que no sea la llave de otra IA ni un token de Messenger/Instagram.
      const esDeMeta = proveedorDeLaLlave === "meta";
      if (!pareceLlaveDeIa(llave, esDeMeta ? "meta" : undefined)) {
        const motivo = esDeMeta
          ? "err:Eso no parece la llave de la IA de Meta. Es la de dev.meta.ai: no el token de la Página (EAA…) ni el de Instagram (IGAA…), ni una llave de Claude, ChatGPT o Grok. No se guardó."
          : "err:Eso no parece una API key (empiezan con sk-ant-, sk- o xai-; la de Meta, eligiendo antes Muse Spark como proveedor). No se guardó: si tu navegador la autocompletó, bórrala del campo antes de guardar.";
        return c.redirect(`/admin/config?llmtest=${encodeURIComponent(motivo)}`);
      }
      await repo.set(SETTING_KEYS.llmApiKey, llave);
    }
  }

  return c.redirect("/admin/config?saved=1");
});

// El aviso rojo de Config: un system_prompt_override guardado reemplaza el
// prompt entero. "convertir" lo pasa a Instrucciones adicionales (se suman);
// "borrar" lo quita. Solo toca esas dos llaves, aunque el formulario mande todo.
adminApp.post("/config/override", async (c) => {
  const form = await c.req.formData();
  const repo = new SettingsRepo(new Db(c.env.DB));
  const accion = String(form.get("accion") ?? "");
  const override = ((await repo.get(SETTING_KEYS.systemPromptOverride)) ?? "").trim();
  if (accion === "convertir" && override) {
    const previas = ((await repo.get(SETTING_KEYS.customInstructions)) ?? "").trim();
    await repo.set(SETTING_KEYS.customInstructions, previas ? `${previas}\n${override}` : override);
  }
  if (accion === "convertir" || accion === "borrar") {
    await repo.set(SETTING_KEYS.systemPromptOverride, "");
  }
  return c.redirect("/admin/config?saved=1");
});

// --- CSV export -------------------------------------------------------------

// Todos los contactos (no solo los leads): quién escribió, su teléfono, si vino
// de un anuncio y en qué quedó.
adminApp.get("/contactos/export.csv", async (c) => {
  const csv = await exportarContactosCsv(c.env);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

// La foto, la nota de voz o el documento que mandó un cliente (src/media/adjuntos.ts).
adminApp.get("/adjuntos/:id", async (c) =>
  servirAdjunto(c.env, c.req.param("id"), c.req.raw, c.req.query("descargar") === "1"),
);

// La conversación en texto plano: «Copiar» la lee, «Descargar» la baja.
adminApp.get("/conversations/:id/texto", async (c) => {
  const id = c.req.param("id");
  const db = new Db(c.env.DB);
  const conv = await new ConversationsRepo(db).getById(id);
  if (!conv) return c.text("Conversación no encontrada.", 404);
  const msgs = await db.all<{ role: string; content: string; created_at: number }>(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [id],
  );
  const texto = conversacionEnTexto(c.env, conv, msgs, await adjuntosDe(c.env, id));
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (c.req.query("descargar") === "1") {
    const nombre = (conv.display_name || conv.channel_user_id || "conversacion")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "conversacion";
    headers["Content-Disposition"] = `attachment; filename="conversacion-${nombre}-${new Date().toISOString().slice(0, 10)}.txt"`;
  }
  return new Response(texto, { headers });
});

adminApp.get("/leads/export.csv", async (c) => {
  const csv = await exportLeadsCsv(c.env);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${Date.now()}.csv"`,
    },
  });
});

// --- Mutating actions (HTMX / plain form posts) -----------------------------

const LEAD_STATUSES: ReadonlyArray<Lead["status"]> = ["new", "contacted", "sold", "lost"];

// Mark a lead's status (nuevo / contactado / vendido / perdido).
adminApp.post("/leads/:id/status", async (c) => {
  const form = await c.req.formData();
  const raw = String(form.get("status") ?? "new");
  const status: Lead["status"] = (LEAD_STATUSES as readonly string[]).includes(raw)
    ? (raw as Lead["status"])
    : "new";
  const leads = new LeadsRepo(new Db(c.env.DB));
  await leads.setStatus(c.req.param("id"), status);

  // Vendido: si el cliente llegó por un anuncio de WhatsApp, se le avisa a Meta
  // la compra con su monto (src/meta/conversiones.ts). Nunca frena el cambio.
  if (status === "sold") {
    const monto = montoDe(String(form.get("monto") ?? ""));
    const lead = await new Db(c.env.DB).first<{ conversation_id: string | null }>(
      "SELECT conversation_id FROM leads WHERE id = ?",
      [c.req.param("id")],
    );
    if (lead?.conversation_id && monto) {
      await avisarAMeta(c.env, lead.conversation_id, "Purchase", { valor: monto });
    }
  }
  return c.redirect("/admin/leads");
});

// Resolve a support ticket.
adminApp.post("/tickets/:id/resolve", async (c) => {
  const form = await c.req.formData();
  const resolvedBy = String(form.get("resolved_by") ?? c.env.OWNER_EMAIL ?? "admin").trim() || "admin";
  const tickets = new TicketsRepo(new Db(c.env.DB));
  await tickets.resolve(c.req.param("id"), resolvedBy);
  return c.redirect("/admin/tickets");
});

// --- Inbox actions (F1) -------------------------------------------------------

// Cuánto se calla el bot cuando el dueño contesta o pausa desde el panel: lo
// decide el ajuste `takeover_minutes` (pestaña Config), el mismo que usan el
// teléfono del WhatsApp por QR y Telegram. Ver src/takeover.ts.

// Reply AS A HUMAN from the dashboard: sends through the conversation's channel
// adapter (Twilio/Telegram/Meta/ManyChat), persists the message as role=owner,
// and pauses the bot (owner takeover — same behavior as isOwnerMessage in the
// agent). Returns a status line for #send-status plus an out-of-band swap that
// refreshes #thread-live instantly. X-Sent: 1 tells the composer to reset.
adminApp.post("/conversations/:id/reply", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.formData().catch(() => null);
  const text = String(form?.get("text") ?? "").trim();
  if (!text) return c.html(`<span class="text-stone-400">Escribe un mensaje primero.</span>`);

  const db = new Db(c.env.DB);
  const convs = new ConversationsRepo(db);
  const conv = await convs.getById(id);
  if (!conv) return c.html(`<span class="text-red-600">✗ Conversación no encontrada.</span>`);

  try {
    const adapter = pickAdapter(conv.channel as ChannelId);
    await adapter.sendReply(
      {
        channel: conv.channel as ChannelId,
        channelUserId: conv.channel_user_id,
        chunks: [text],
        interChunkDelayMs: 0,
      },
      c.env,
    );
  } catch (e) {
    // Nothing persisted on failure: the customer never got the message.
    const msg = e instanceof Error ? e.message : String(e);
    return c.html(`<span class="text-red-600">✗ No se pudo enviar: ${escapeHtml(msg)}</span>`);
  }

  const msgs = new MessagesRepo(db);
  await msgs.append(id, "owner", text);
  await convs.touchLastMessage(id);
  await pausarPorHumano(c.env, id, "panel");

  c.header("X-Sent", "1");
  return c.html(
    `<span class="text-emerald-600">✓ Enviado por ${escapeHtml(channelLabel(conv.channel))}</span>` +
      `<div id="thread-live" hx-swap-oob="innerHTML">${await renderThreadLive(c.env, id)}</div>`,
  );
});

// Mandarle un archivo al cliente (una cotización, una foto), como en D'Casa.
// Igual que responder desde el panel: sale por el canal, queda en el hilo como
// mensaje del equipo y el bot se calla en esta conversación.
adminApp.post("/conversations/:id/archivo", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.formData().catch(() => null);
  // FormData de Workers tipa get() como string; lo que llega es un File.
  const archivo = form?.get("archivo") as unknown as File | string | null;
  const leyenda = String(form?.get("leyenda") ?? "").trim();
  if (!archivo || typeof archivo === "string" || archivo.size === 0) {
    return c.html(`<span style="color:var(--bad)">Elige un archivo primero.</span>`);
  }
  if (archivo.size > MEDIA_MAXIMA) {
    return c.html(`<span style="color:var(--bad)">✗ Pesa más de 12 MB. Mándalo más liviano.</span>`);
  }

  const db = new Db(c.env.DB);
  const convs = new ConversationsRepo(db);
  const conv = await convs.getById(id);
  if (!conv) return c.html(`<span style="color:var(--bad)">✗ Conversación no encontrada.</span>`);

  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const mime = archivo.type || "application/octet-stream";
  const nombre = (archivo.name || "archivo").slice(0, 120);
  try {
    await enviarArchivo(c.env, conv.channel, conv.channel_user_id, { bytes, mime, nombre }, leyenda);
  } catch (e) {
    // No se guarda nada: al cliente no le llegó.
    const msg = e instanceof Error ? e.message : String(e);
    return c.html(`<span style="color:var(--bad)">✗ No se pudo enviar: ${escapeHtml(msg)}</span>`);
  }

  const tipo = /^image\/(jpeg|png|gif|webp)$/.test(mime) ? "imagen" : mime.startsWith("audio/") ? "audio" : "documento";
  const adjunto = await guardarAdjunto(c.env, id, { bytes, mime }, tipo, nombre);
  // El bot lee «(le mandamos: …)»; el panel lo cambia por el archivo.
  const contenido = [leyenda, `(le mandamos: ${nombre})`, adjunto ? marcaDeAdjunto(adjunto) : ""].filter(Boolean).join("\n");
  await new MessagesRepo(db).append(id, "owner", contenido);
  await convs.touchLastMessage(id);
  await pausarPorHumano(c.env, id, "panel");

  c.header("X-Sent", "1");
  return c.html(
    `<span style="color:var(--ok)">✓ Archivo enviado por ${escapeHtml(channelLabel(conv.channel))}</span>` +
      `<div id="thread-live" hx-swap-oob="innerHTML">${await renderThreadLive(c.env, id)}</div>`,
  );
});

// Pause the bot in this conversation without sending anything (owner wants the
// customer for themselves). Returns the refreshed thread fragment.
adminApp.post("/conversations/:id/pause", async (c) => {
  const id = c.req.param("id");
  await pausarPorHumano(c.env, id, "panel");
  return c.html(await renderThreadLive(c.env, id));
});

// Return a paused conversation back to the bot. Clears paused_until AND appends
// an owner-authored note to the message history, so the bot resumes with
// context about what the owner already resolved.
//
// La nota es OPCIONAL. Antes el formulario vivía dentro del bloque que se
// refresca cada 5 s: devolver una conversación costaba varios intentos. Y se
// cierran los tickets abiertos de la conversación: devolverla al bot es decir
// "esto ya lo atendí". Sin cerrarlos, openTicketAndNotify veía "ya hay un
// ticket abierto" y el siguiente aviso al dueño de esa conversación se perdía.
adminApp.post("/conversations/:id/resume", async (c) => {
  const id = c.req.param("id");
  await devolverAlBot(c.env, id, {
    nota: String((await c.req.formData().catch(() => null))?.get("summary") ?? ""),
    quien: "panel",
  });
  // Desde htmx se devuelve el hilo ya actualizado; sin JavaScript, la página.
  if (c.req.header("HX-Request")) return c.html(await renderThreadLive(c.env, id));
  return c.redirect(`/admin/conversations?c=${encodeURIComponent(id)}`);
});

// Eliminar la conversación completa: mensajes, análisis, hechos del cliente y
// etiquetas de campaña. Es irreversible, por eso el botón del panel pregunta
// antes. Leads y tickets sobreviven (son del negocio, no del chat) y el gasto
// de IA ya facturado se conserva en Costos.
adminApp.post("/conversations/:id/delete", async (c) => {
  const id = c.req.param("id");
  const db = new Db(c.env.DB);
  const convs = new ConversationsRepo(db);
  const conv = await convs.getById(id);
  if (!conv) return c.redirect("/admin/conversations?deleted=0");

  // Sus fotos, audios y documentos se van con ella. Si falla, se borra igual.
  await borrarAdjuntosDe(c.env, id).catch((e) => console.error("[admin] no se pudieron borrar los adjuntos:", e));
  await borrarEventosDe(c.env, id).catch((e) => console.error("[admin] no se pudieron borrar los avisos a Meta:", e));
  await convs.delete(id);

  // El Durable Object tiene su propio estado (buffer de mensajes, contadores):
  // sin limpiarlo, el siguiente mensaje del cliente seguiría arrastrando el
  // contexto de un chat que el dueño acaba de borrar. Si falla, el borrado en
  // la base ya está hecho: se avisa al log y no se rompe la respuesta.
  try {
    const doId = c.env.AGENT.idFromName(`${conv.channel}:${conv.channel_user_id}`);
    await c.env.AGENT.get(doId).resetConversation();
  } catch (e) {
    console.error("[admin] no se pudo limpiar el estado del agente:", e);
  }

  return c.redirect("/admin/conversations?deleted=1");
});

// --- Co-pilot (HTMX-driven suggestion) --------------------------------------

/** Escape untrusted text (LLM output) before interpolating into an HTML fragment. */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

// "Suggest Reply": call Anthropic with the recent conversation history + the
// business context and return ONE short message the owner can copy/paste (or
// send manually via WhatsApp). It does NOT send anything to the customer — it
// only returns an HTML fragment for HTMX to swap into the suggestion area.
//
// Auth: already enforced by the wildcard Basic Auth middleware above, so there
// is no per-route auth check here (no magic-link `requireAuth`).
adminApp.post("/conversations/:id/suggest", async (c) => {
  const db = new Db(c.env.DB);
  const msgs = new MessagesRepo(db);
  const history = await msgs.lastN(c.req.param("id"), 20);
  const { model, modelId } = createModel(c.env, "fast", await loadLlmOverrides(c.env));
  const aiMessages = history.map((m) => ({
    role: (m.role === "tool" ? "user" : m.role === "owner" ? "assistant" : m.role) as
      | "user"
      | "assistant",
    content: m.content,
  }));
  aiMessages.push({
    role: "user",
    content:
      "Eres asistente del dueño. Sugiere UN solo mensaje corto en español que el dueño podría enviar al cliente para resolver la última consulta. NO incluyas preámbulo, solo la frase a copy/paste.",
  });
  const sys = systemPromptFromEnv(c.env, [], await contextoDelNegocio(c.env));
  const result = await generateText({
    model,
    system: sys,
    messages: aiMessages,
  });
  await recordAiUsage(db, {
    source: "suggest",
    conversationId: c.req.param("id"),
    model: modelId,
    usage: usageFromSdk(result.totalUsage),
  });
  // HTMX swaps this into #suggestion-box; the "Usar" button fills the composer.
  return c.html(renderSuggestionBox(result.text));
});

// --- Fallback ---------------------------------------------------------------

adminApp.notFound((c) =>
  c.html(
    layout({
      title: "No encontrado",
      activeTab: "overview",
      body: "<p class='text-stone-500'>Página no encontrada.</p>",
    }),
    404,
  ),
);
