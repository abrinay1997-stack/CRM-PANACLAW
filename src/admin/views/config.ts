// Pro dashboard "Config" tab — a VISUAL CONTROL PANEL for a non-technical owner
// (e.g. a barbershop owner). No raw numbers, no "pick 1-10": every technical
// setting is a group of 2-3 selectable cards (radio + inline SVG icon + short
// label + one-line plain-Spanish description). Text settings are plain inputs /
// textareas with clear labels (no jargon). The form POSTs to /admin/config.
import { MOTIVO_NO_CLIENTE, type MotivoNoCliente } from "../../noCliente";
import type { Env } from "../../env";
import { SETTING_KEYS } from "../../db/settings";
import { CURATED_MODELS, entrenaConLosDatos } from "../../llm/provider";
import { haceCuanto, leerFalloLlm } from "../../llm/ultimoFallo";
import type { EstadoMeta } from "../../meta/conversiones";
import {
  CONTROL_LIST,
  valueToLevel,
  type ControlDef,
} from "../control-levels";
import {layout, ico} from "./layout";

/** Escape untrusted text before interpolating it into an HTML attribute/body. */
function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

// Brand accent = flash-orange (#ff5100), defined once in views/layout.ts and
// documented in docs/design-system.md. (It used to say cyan / retro-terminal:
// that theme — square corners, hard shadows, CRT scanlines — was retired, see
// design-system.md §2b.) The selected card lights up accent; the hidden radio
// drives the highlight via Tailwind's `peer` utilities so the whole card is
// clickable (it's a <label>).
const CARD_BASE =
  "peer-checked:border-accent peer-checked:bg-accent-soft " +
  "peer-checked:[&_.card-icon]:text-accent peer-checked:[&_.card-label]:text-accent " +
  "cfgcard flex flex-col gap-1 h-full border border-line bg-panel2 p-4 cursor-pointer";

/** Render one card group (radio cards) for a level-based control. */
/**
 * Valor que se envía para "dejar lo guardado como está". Existe porque un
 * valor que no es ninguna de las tarjetas —un tono escrito a mano— se mostraba
 * con la PRIMERA tarjeta marcada, y guardar la página por cualquier otro motivo
 * lo cambiaba sin que nadie lo decidiera. Pasó en Baby Caleb.
 */
export const CONSERVAR = "__actual__";

function renderCardGroup(control: ControlDef, settings: Record<string, string>): string {
  const guardado = (settings[control.key] ?? "").trim();
  const propio = guardado !== "" && !control.options.some((o) => o.value === guardado);
  const currentLevel = propio ? null : valueToLevel(control.key, settings[control.key]);
  const tarjetaPropia = propio
    ? `
        <div class="relative">
          <input type="radio" id="${esc(control.key)}__actual" name="${esc(control.key)}" value="${CONSERVAR}"
                 class="peer sr-only absolute" checked>
          <label for="${esc(control.key)}__actual" class="${CARD_BASE}">
            <span class="card-label font-display font-semibold text-[12.5px] text-cream">Personalizado</span>
            <span class="text-dim text-[11px] leading-snug">${esc(guardado)}</span>
          </label>
        </div>`
    : "";
  const cards = tarjetaPropia + control.options
    .map((opt) => {
      const id = `${control.key}__${opt.value}`;
      const checked = opt.label === currentLevel ? "checked" : "";
      return `
        <div class="relative">
          <input type="radio" id="${esc(id)}" name="${esc(control.key)}" value="${esc(opt.value)}"
                 class="peer sr-only absolute" ${checked}>
          <label for="${esc(id)}" class="${CARD_BASE}">
            <span class="card-icon text-dim">${opt.svg}</span>
            <span class="card-label font-display font-semibold text-[12.5px] text-cream">${esc(opt.label)}</span>
            <span class="text-dim text-[11px] leading-snug">${esc(opt.desc)}</span>
          </label>
        </div>`;
    })
    .join("");
  // El tono es el único control que un negocio suele querer con sus propias
  // palabras. Sin este campo, eso solo se podía escribir tocando la base.
  const libre =
    control.key === SETTING_KEYS.tone
      ? `<label class="text-dim text-[12px]" for="tone_libre" style="margin-top:4px">…o escríbelo con tus palabras (reemplaza la tarjeta elegida):</label>
         <input type="text" id="tone_libre" name="tone_libre" value="" placeholder="Ej. cercano y directo, sin tecnicismos"
                style="${INPUT_STYLE};font-size:16px">`
      : "";
  return `
    <fieldset style="display:flex;flex-direction:column;gap:8px">
      <legend class="font-display font-semibold text-[13.5px] text-cream">${esc(control.title)}</legend>
      <p class="text-muted text-[12px]">${esc(control.help)}</p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">${cards}</div>
      ${libre}
    </fieldset>`;
}

const INPUT_STYLE =
  "background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none;width:100%";

/** Render a labeled single-line text field. */
function renderTextField(opts: {
  name: string;
  label: string;
  help: string;
  value: string;
  placeholder?: string;
}): string {
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <label for="${esc(opts.name)}" class="font-display font-semibold text-[12.5px] text-cream">${esc(opts.label)}</label>
      <p class="text-dim text-[11px]">${esc(opts.help)}</p>
      <input type="text" id="${esc(opts.name)}" name="${esc(opts.name)}"
             value="${esc(opts.value)}" placeholder="${esc(opts.placeholder ?? "")}"
             style="${INPUT_STYLE}">
    </div>`;
}

/** Render a labeled multi-line textarea. */
function renderTextArea(opts: {
  name: string;
  label: string;
  help: string;
  value: string;
  placeholder?: string;
  rows?: number;
}): string {
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      <label for="${esc(opts.name)}" class="font-display font-semibold text-[12.5px] text-cream">${esc(opts.label)}</label>
      <p class="text-dim text-[11px]">${esc(opts.help)}</p>
      <textarea id="${esc(opts.name)}" name="${esc(opts.name)}" rows="${opts.rows ?? 4}"
                placeholder="${esc(opts.placeholder ?? "")}"
                style="${INPUT_STYLE};resize:vertical">${esc(opts.value)}</textarea>
    </div>`;
}

const SELECT_STYLE =
  "background:var(--bg);border:1px solid var(--line);color:var(--cream);padding:10px 12px;font-size:12.5px;outline:none;width:100%";

/** Sección "Modelo de IA": proveedor + API key propia + modelo concreto. */
function renderLlmSection(settings: Record<string, string>, llmTest?: string): string {
  const provider = settings[SETTING_KEYS.llmProvider] ?? "";
  const model = settings[SETTING_KEYS.llmModel] ?? "";
  const hasKey = (settings[SETTING_KEYS.llmApiKey] ?? "").trim() !== "";
  const keyTail = hasKey ? (settings[SETTING_KEYS.llmApiKey] ?? "").trim().slice(-4) : "";

  const providerOpts = [
    { v: "", l: "Automático (recomendado)" },
    { v: "anthropic", l: "Claude (Anthropic)" },
    { v: "openai", l: "ChatGPT (OpenAI)" },
    { v: "xai", l: "Grok (xAI)" },
    { v: "meta", l: "Muse Spark (Meta)" },
  ]
    .map((o) => `<option value="${o.v}" ${provider === o.v ? "selected" : ""}>${o.l}</option>`)
    .join("");

  const anthropicOpts = CURATED_MODELS.filter((m) => m.provider === "anthropic")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  const openaiOpts = CURATED_MODELS.filter((m) => m.provider === "openai")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  const xaiOpts = CURATED_MODELS.filter((m) => m.provider === "xai")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");
  const metaOpts = CURATED_MODELS.filter((m) => m.provider === "meta")
    .map((m) => `<option value="${esc(m.id)}" ${model === m.id ? "selected" : ""}>${esc(m.label)}</option>`)
    .join("");

  // El Contributor es barato porque Meta entrena con lo que recibe, y aquí lo
  // que recibe son las conversaciones de los clientes. Mientras esté elegido,
  // el aviso no se puede cerrar: es una decisión que tiene que seguir a la vista.
  const avisoEntrena = entrenaConLosDatos(model)
    ? `<div role="alert" style="border:1px solid var(--bad);background:rgba(244,54,76,.08);color:var(--bad);padding:10px 12px;font-size:12px;font-weight:600">⚠ Con Muse Spark Contributor, Meta usa lo que se le envía para entrenar sus modelos: aquí eso son las conversaciones de tus clientes (nombres, teléfonos, lo que te cuentan). Si no lo quieres, elige Muse Spark 1.3.</div>`
    : "";

  let testBanner = "";
  if (llmTest?.startsWith("ok:")) {
    testBanner = `<div style="border:1px solid var(--ok);background:rgba(87,201,138,.1);color:var(--ok);padding:9px 12px;font-size:12px;font-weight:600">✓ Conexión exitosa — respondió ${esc(llmTest.slice(3))}</div>`;
  } else if (llmTest?.startsWith("err:")) {
    testBanner = `<div style="border:1px solid var(--bad);background:rgba(244,54,76,.1);color:var(--bad);padding:9px 12px;font-size:12px;font-weight:600">✕ Falló la prueba: ${esc(llmTest.slice(4, 200))}</div>`;
  }

  // El error real del último mensaje que falló (src/llm/ultimoFallo.ts). La
  // prueba de abajo es una petición mínima; el chat real lleva herramientas y
  // streaming, y puede fallar donde la prueba no. Solo se muestra si es reciente.
  const fallo = leerFalloLlm(settings);
  const falloBanner =
    fallo && Date.now() - fallo.cuando < 48 * 60 * 60 * 1000
      ? `<div role="status" style="border:1px solid var(--bad);background:rgba(244,54,76,.08);padding:10px 12px;font-size:12px;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere">
          <strong style="color:var(--bad)">Último fallo real del bot · ${esc(haceCuanto(fallo.cuando))} · ${esc(fallo.proveedor)}/${esc(fallo.modelo)}</strong>
          <span class="text-cream">${esc(fallo.mensaje)}</span>
          <span class="text-dim">${fallo.recuperado ? `El cliente recibió respuesta${fallo.respaldo ? ` del modelo de respaldo (${esc(fallo.respaldo)})` : " en un reintento"}.` : "El cliente recibió «Algo falló de mi lado»."}</span>
        </div>`
      : "";

  return `
    <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:18px">
      <div style="display:flex;flex-direction:column;gap:2px">
        <h3 class="font-display font-semibold text-[13.5px] text-cream">${ico("brain")} Modelo de IA</h3>
        <p class="text-dim text-[12px]">Elige qué inteligencia artificial usa tu bot. Puedes usar tu propia API key para pagar tú el consumo directamente. Si lo dejas en automático, el bot usa la configuración incluida (rápido para lo simple, inteligente para lo difícil).</p>
      </div>
      ${testBanner}
      ${falloBanner}
      ${avisoEntrena}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div style="display:flex;flex-direction:column;gap:6px">
          <label class="font-display font-semibold text-[12.5px] text-cream">Proveedor</label>
          <select name="${SETTING_KEYS.llmProvider}" style="${SELECT_STYLE}">${providerOpts}</select>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <label class="font-display font-semibold text-[12.5px] text-cream">Modelo</label>
          <select name="${SETTING_KEYS.llmModel}" style="${SELECT_STYLE}">
            <option value="" ${model === "" ? "selected" : ""}>Automático (rápido ⇄ inteligente)</option>
            <optgroup label="Claude (Anthropic)">${anthropicOpts}</optgroup>
            <optgroup label="ChatGPT (OpenAI)">${openaiOpts}</optgroup>
            <optgroup label="Grok (xAI)">${xaiOpts}</optgroup>
            <optgroup label="Muse Spark (Meta)">${metaOpts}</optgroup>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label class="font-display font-semibold text-[12.5px] text-cream">Tu API key (opcional)</label>
        <p class="text-dim text-[11px]">${hasKey ? `Hay una key guardada (termina en …${esc(keyTail)}). Escribe una nueva para reemplazarla, o marca la casilla para quitarla.` : "Pégala aquí para que el consumo se cobre a tu cuenta. Vacío = usar la key incluida del sistema."} Para Meta es la llave de dev.meta.ai — no el token de la Página ni el de Instagram de la pestaña Conexiones.</p>
        <input type="password" name="${SETTING_KEYS.llmApiKey}" value="" autocomplete="new-password" data-1p-ignore data-lpignore="true"
               placeholder="${hasKey ? "••••••••••••" : "sk-ant-… o sk-…"}" style="${INPUT_STYLE}">
        ${hasKey ? `<label class="text-dim text-[11.5px]" style="display:flex;align-items:center;gap:7px;cursor:pointer"><input type="checkbox" name="llm_api_key_clear" value="1"> Quitar mi API key y volver a la del sistema</label>` : ""}
      </div>
      <a href="/admin/config/llm-test" class="text-[12px] font-display font-semibold"
         style="width:fit-content;border:1px solid var(--line);color:var(--cream);padding:9px 14px;text-decoration:none">${ico("zap")} Probar mi configuración (guarda primero)</a>
    </div>`;
}

/**
 * El aviso que faltaba. `system_prompt_override` REEMPLAZA el prompt entero —
 * fuentes de verdad, contexto del negocio, reglas—, y hasta el 23-sep-2026 este
 * mismo formulario lo escribía desde un campo que decía "reglas especiales". Si
 * hay uno guardado, se muestra aquí con la salida a un toque.
 */
function renderOverrideWarning(settings: Record<string, string>): string {
  const override = (settings[SETTING_KEYS.systemPromptOverride] ?? "").trim();
  if (!override) return "";
  const corto = override.length <= 600;
  return `
    <div style="border:1px solid var(--bad);background:rgba(244,54,76,.08);padding:14px;display:flex;flex-direction:column;gap:10px">
      <p class="text-[12.5px]" style="margin:0;color:var(--bad);font-weight:700">⚠ Hay un prompt personalizado que REEMPLAZA toda la configuración automática</p>
      <p class="text-[12px] text-muted" style="margin:0">Mientras exista, el bot no ve sus fuentes de verdad, ni la información del negocio, ni sus reglas. Esto dice:</p>
      <blockquote class="text-[12px] text-cream" style="margin:0;padding:8px 10px;border-left:2px solid var(--line);white-space:pre-wrap">${esc(override.slice(0, 600))}${override.length > 600 ? "…" : ""}</blockquote>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${
          corto
            ? `<button type="submit" formaction="/admin/config/override" name="accion" value="convertir" formnovalidate
                 style="font-size:12px;font-weight:700;padding:10px 14px;min-height:44px;cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:var(--on-accent)">
                 Convertirlo en instrucción adicional
               </button>`
            : ""
        }
        <button type="submit" formaction="/admin/config/override" name="accion" value="borrar" formnovalidate
                style="font-size:12px;font-weight:700;padding:10px 14px;min-height:44px;cursor:pointer;background:none;border:1px solid var(--line);color:var(--cream)">
          Borrarlo y volver al automático
        </button>
      </div>
    </div>`;
}

/**
 * Conversiones para Meta Ads (src/meta/conversiones.ts): qué se le está avisando
 * a Meta, el conjunto de datos y un botón que manda un evento de prueba.
 */
/**
 * Cómo rinde cada anuncio (src/meta/porAnuncio.ts): la tabla con la que se
 * decide cada lunes qué anuncio se pausa. En el teléfono cada fila es una
 * tarjeta (§7f).
 */
function renderPorAnuncio(meta: EstadoMeta): string {
  const p = meta.porAnuncio;
  if (!p) return "";
  const periodo = (d: number) =>
    d === p.dias
      ? `<span class="text-cream" aria-current="true" style="font-weight:700">${d} días</span>`
      : `<a href="/admin/config?anuncios=${d}#meta" class="tap" style="color:var(--accent);display:inline-flex;align-items:center">${d} días</a>`;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");
  const th = (t: string, alinear = "right") =>
    `<th scope="col" class="text-dim" style="text-align:${alinear};font-size:12px;font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)">${t}</th>`;
  const td = (etiqueta: string, v: string, alinear = "right") =>
    // El valor va en UN solo hijo: en el teléfono la celda es flex (etiqueta a
    // la izquierda, valor a la derecha) y cada hijo suelto se separaría.
    `<td data-label="${etiqueta}" style="text-align:${alinear};padding:8px;border-bottom:1px solid var(--line);font-size:13px"><span>${v}</span></td>`;
  const filas = p.filas
    .map(
      (f) => `<tr>
        ${td(
          "Anuncio",
          `<span class="text-cream">${esc(f.titular)}</span>${f.anuncioId ? `<br><span class="text-dim" style="font-size:12px">id ${esc(f.anuncioId)}</span>` : ""}`,
          "left",
        )}
        ${td("Llegaron", String(f.llegaron))}
        ${td("Contestaron", `${f.contestaron} <span class="text-dim">(${pct(f.contestaron, f.llegaron)})</span>`)}
        ${td(
          "No eran clientes",
          `${f.noClientes}${
            f.noClientes
              ? `<br><span class="text-dim" style="font-size:11px">${Object.entries(f.motivos)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .map(([m, n]) => `${n} ${esc(MOTIVO_NO_CLIENTE[m as MotivoNoCliente].toLowerCase())}`)
                  .join(" · ")}</span>`
              : ""
          }`,
        )}
        ${td("Leads", String(f.leads))}
        ${td("Ventas", String(f.ventas))}
      </tr>`,
    )
    .join("");
  const tabla = p.filas.length
    ? `<table class="tablecards" style="width:100%;border-collapse:collapse">
        <thead><tr>${th("Anuncio", "left")}${th("Llegaron")}${th("Contestaron")}${th("No eran clientes")}${th("Leads")}${th("Ventas")}</tr></thead>
        <tbody>${filas}</tbody>
      </table>`
    : `<p class="text-[12px] text-dim" style="margin:0">Nadie llegó por un anuncio en estos ${p.dias} días.</p>`;
  return `
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px">
          <h4 class="font-display font-semibold text-[13px] text-cream" style="margin:0">Cómo rinde cada anuncio</h4>
          <span class="text-[12px] text-dim" style="display:inline-flex;gap:12px;align-items:center">${periodo(7)} ${periodo(30)}</span>
        </div>
        <p class="text-[12px] text-dim" style="margin:0">Contado en el CRM. «Contestaron» es quien escribió algo suyo además del mensaje automático del anuncio. «No eran clientes»: buscaban un préstamo o empleo, escribieron por error o solo saludaron. El gasto está en el Administrador de anuncios: divídalo entre «Contestaron» y sabrá cuánto le cuesta cada conversación que contesta.</p>
        ${tabla}
      </div>`;
}

function renderMetaSection(settings: Record<string, string>, meta: EstadoMeta | null): string {
  if (!meta) return "";
  const fecha = (ms: number) => new Date(ms).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const color = (e: string) => (e === "enviado" ? "var(--ok)" : e === "fallo" ? "var(--bad)" : "var(--muted)");
  const ultimo = meta.ultimo
    ? `<p class="text-[12px]" style="margin:0;color:${color(meta.ultimo.estado)}">Último aviso (${esc(meta.ultimo.evento)}, ${fecha(meta.ultimo.at)}): ${esc(meta.ultimo.detalle)}</p>`
    : `<p class="text-[12px] text-dim" style="margin:0">Todavía no se le ha avisado nada a Meta.</p>`;
  const cifra = (n: number, txt: string) =>
    `<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="font-display font-bold text-[18px] text-cream">${n}</span><span class="text-dim text-[12px]">${txt}</span></div>`;
  return `
    <div id="meta" class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;flex-direction:column;gap:4px">
        <h3 class="font-display font-semibold text-[13px] text-cream" style="margin:0;display:flex;align-items:center;gap:8px">${ico("megaphone")} Publicidad en Meta: conversiones</h3>
        <p class="text-muted text-[12px]" style="margin:0">Cuando alguien llega por un anuncio de WhatsApp, el bot le avisa a Meta si se volvió lead y, cuando marcas el lead como «Vendido», la compra con su monto. Así Meta aprende qué anuncios traen clientes de verdad y no solo gente que escribe. Solo se manda el código del clic, nunca el nombre ni el teléfono.</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
        ${cifra(meta.clics30d, "con el código del clic, para Meta (30 días)")}
        ${cifra(meta.leads30d, "leads avisados a Meta")}
        ${cifra(meta.ventas30d, "ventas avisadas a Meta")}
        ${cifra(meta.fallos30d, "avisos que fallaron")}
      </div>
      ${ultimo}
      ${renderPorAnuncio(meta)}
      <p class="text-[12px] text-dim" style="margin:0">Cuenta de WhatsApp Business: ${meta.wabaId ? esc(meta.wabaId) : "se detecta sola con el primer mensaje que llegue de un anuncio"}.</p>
      ${renderTextField({
        name: SETTING_KEYS.metaDatasetId,
        label: "Conjunto de datos de Meta (opcional)",
        help: "Se busca solo la primera vez. Si en el Administrador de eventos usas otro conjunto de datos para WhatsApp, pega aquí su número.",
        value: settings[SETTING_KEYS.metaDatasetId] ?? "",
        placeholder: "Se detecta solo",
      })}
      <div style="display:flex;flex-direction:column;gap:6px">
        <label for="meta_codigo_prueba" class="font-display font-semibold text-[12.5px] text-cream">Probar el envío</label>
        <p class="text-dim text-[11px]">En el Administrador de eventos de Meta, abre tu conjunto de datos → «Probar eventos», copia el código (TEST…) y pégalo aquí. Se manda un lead de prueba con el último clic que llegó por un anuncio: se ve allá y no cuenta para tus anuncios.</p>
        <div class="row-wrap" style="display:flex;gap:9px;align-items:center">
          <input type="text" id="meta_codigo_prueba" name="meta_codigo_prueba" placeholder="TEST12345" class="row-grow" style="${INPUT_STYLE};flex:1">
          <button type="submit" formaction="/admin/meta/probar" formnovalidate
                  style="font-size:12px;font-weight:700;padding:10px 14px;min-height:44px;cursor:pointer;background:none;border:1px solid var(--line);color:var(--cream);white-space:nowrap">
            Mandar evento de prueba
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Render the Config tab. Receives the current settings overlay (Record from
 * SettingsRepo.all()). `saved` shows the "Guardado ✓" confirmation banner after
 * a redirect from POST /admin/config?saved=1.
 */
export function renderConfig(
  env: Env,
  settings: Record<string, string>,
  saved = false,
  llmTest?: string,
  meta: EstadoMeta | null = null,
): string {
  const cardGroups = CONTROL_LIST.map((c) => renderCardGroup(c, settings)).join("");

  const savedBanner = saved
    ? `<div style="border:1px solid var(--ok);background:rgba(87,201,138,.1);color:var(--ok);padding:10px 14px;font-size:12.5px;font-weight:600">Guardado ✓</div>`
    : "";

  const body = `
    <form method="POST" action="/admin/config" style="display:flex;flex-direction:column;gap:28px">
      ${savedBanner}

      <div style="display:flex;flex-direction:column;gap:2px">
        <h2 class="font-display font-semibold text-[15px] text-cream">Panel de control de ${esc(env.BUSINESS_NAME)}</h2>
        <p class="text-muted text-[12.5px]">Ajuste cómo se comporta su bot. Los cambios se guardan al presionar el botón de abajo.</p>
      </div>

      <!-- Card-based controls (tono, velocidad, estilo, cerebro, estado) -->
      <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:22px">
        ${cardGroups}
      </div>

      <!-- Modelo de IA (BYO provider/key/model) -->
      ${renderLlmSection(settings, llmTest)}

      ${renderMetaSection(settings, meta)}

      <!-- Free-text settings -->
      <div class="bg-panel border border-line" style="padding:20px;display:flex;flex-direction:column;gap:18px">
        ${renderTextField({
          name: SETTING_KEYS.botName,
          label: "Nombre del bot",
          help: "Cómo se presenta su asistente con los clientes.",
          value: settings[SETTING_KEYS.botName] ?? "",
          placeholder: env.BOT_NAME ?? "Mi asistente",
        })}

        ${renderTextArea({
          name: SETTING_KEYS.businessContext,
          label: "Información del negocio",
          help:
            "Horarios, servicios, precios, ubicación y contacto. Es lo ÚNICO que el bot sabe del " +
            "negocio además de la pestaña Conocimiento: se aplica al guardar, sin re-desplegar. Los " +
            "enlaces que el bot puede mandar van aquí mismo, uno por línea: «- Planes: https://…».",
          // GET /config siembra este campo la primera vez (contextoDelNegocio):
          // lo que se ve aquí es exactamente lo que lee el bot.
          value: settings[SETTING_KEYS.businessContext] ?? "",
          placeholder: "Ej. Abrimos lunes a sábado de 9 a 7. Corte $150, barba $100. Estamos en Av. Reforma 123.",
          rows: 6,
        })}

        ${renderOverrideWarning(settings)}

        ${renderTextArea({
          name: SETTING_KEYS.customInstructions,
          label: "Instrucciones adicionales",
          help: "Reglas especiales que se SUMAN a la configuración automática (no la reemplazan). Una por línea. Para que el bot se calle cuando tú contestas no hace falta escribir nada: eso ya pasa solo.",
          value: settings[SETTING_KEYS.customInstructions] ?? "",
          placeholder: "Ej. Si preguntan por una demo, ofrece agendarla con el equipo.",
          rows: 4,
        })}

        ${renderTextArea({
          name: SETTING_KEYS.frasesProhibidas,
          label: "Frases que el bot nunca dice",
          help:
            "Una por línea; si quieres, el motivo después de « | ». Antes de mandar cada respuesta se " +
            "revisa: si trae una de estas, el bot la rehace y, si insiste, pasa la conversación a una " +
            "persona del equipo. Lo de siempre (dar un pago por recibido, prometer una fecha) ya se " +
            "revisa solo, sin escribirlo aquí.",
          value: settings[SETTING_KEYS.frasesProhibidas] ?? "",
          placeholder: "Ej. te hago descuento | los precios son fijos y públicos",
          rows: 3,
        })}

        ${renderTextField({
          name: SETTING_KEYS.businessHours,
          label: "Horario de atención",
          help:
            "Cuándo hay alguien del equipo. El bot responde a toda hora, pero solo escribe " +
            "primero (seguimientos) dentro de esta ventana, y fuera de ella avisa al cliente " +
            "cuándo le contesta una persona. Formato: L-V 9:00-18:00 · días L M X J V S D.",
          value: settings[SETTING_KEYS.businessHours] ?? "",
          placeholder: "L-V 9:00-18:00",
        })}

        ${renderTextField({
          name: SETTING_KEYS.escalationKeywords,
          label: "Palabras que piden un humano",
          help:
            "Extras, además de lo que ya avisa solo: factura, contrato, tema legal, " +
            "reembolso, cotización, «ya pagué», «quiero contratar», pedir una persona " +
            "y cuando el cliente manda una imagen. Agrega aquí lo propio de tu negocio, " +
            "separado con comas.",
          value: settings[SETTING_KEYS.escalationKeywords] ?? "",
          placeholder: "queja, reembolso, hablar con alguien",
        })}
      </div>

      <button type="submit" class="bigbtn font-display font-bold text-[13px] cursor-pointer"
              style="width:fit-content;background:var(--accent);border:1px solid var(--accent);color:var(--on-accent);box-shadow:0 10px 28px rgba(0,0,0,.5);padding:13px 24px;display:flex;align-items:center;gap:9px">
        <i data-lucide="check" width="16" height="16"></i> Guardar cambios
      </button>
    </form>`;

  return layout({ title: "Config", activeTab: "config", body, env });
}
