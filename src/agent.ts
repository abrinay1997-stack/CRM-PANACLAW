import { Agent } from "agents";
import { streamText } from "ai";
import type { SystemModelMessage } from "ai";
import type { Env } from "./env";
import { Db } from "./db/client";
import { ConversationsRepo } from "./db/conversations";
import { MessagesRepo } from "./db/messages";
import { isPro } from "./config";
import { resolveAgentConfig } from "./settings-loader";
import { buildTools } from "./tools";
import { imagenParaElModelo, mensajeConImagen, NOTA_IMAGEN_ILEGIBLE } from "./media/vision";
import { chunkReply } from "./replies/chunker";
import { pickAdapter } from "./replies/sender";
import {
  fuentesDelPrompt,
  pasajesDeHerramienta,
  revisarCifras,
  avisoDeCifrasInventadas,
  sinFrasesSinRespaldo,
  RESPUESTA_SIN_CIFRA,
  RESPUESTA_SIN_CIFRA_CON_IMAGEN,
} from "./replies/cifras";
import { selectModel } from "./upgrade/modelSelector";
import type { Tier } from "./upgrade/modelSelector";
import { monthIaCostUsd, applyBudgetGuard } from "./budget";
import { CustomerFactsRepo } from "./db/facts";
import { localTime, isWithinBusinessHours } from "./hours";
import { createModel, OPCIONES_POR_PROVEEDOR } from "./llm/provider";
import { anotarFalloLlm, describirError, secretosDelEntorno } from "./llm/ultimoFallo";
import { costOfUsage } from "./pricing";
import { recordAiUsage, usageFromSdk, type TokenUsage } from "./db/aiUsage";
import { pausarPorHumano, viaDeAtencion } from "./takeover";
import { channelLabel, telefonoDelCliente } from "./channels/labels";
import { revisarRespuesta, hayQueBloquear, notaDeRevision, RESPUESTA_SEGURA, type Problema } from "./replies/revisor";
import { esWhatsApp, formatoWhatsApp, sinNarracion, dosificarEmojis, quitarEmojis, tieneEmoji } from "./replies/formato";
import { guardarAdjunto, marcaDeAdjunto, marcaDeFallo, maximoDe, sinMarcasDeAdjunto, type TipoAdjunto } from "./media/adjuntos";
import { esNotaInterna, notaParaElModelo } from "./notas";
import { bytesDeMedia } from "./media/almacen";
import { guardarClic, type AnuncioEntrante } from "./meta/conversiones";
import { revisarNoCliente, notaParaElBot, esAperturaDeAnuncio, type MotivoNoCliente } from "./noCliente";

/**
 * Lo que el modelo ve de un documento que mandó el cliente: que llegó y qué
 * hacer, nunca el enlace (no lo puede abrir, y podría pegárselo al cliente).
 */
export function paraElModelo(contenido: string): string {
  // La marca [ADJUNTO: <id>] es para el panel (src/media/adjuntos.ts): al
  // modelo no le dice nada.
  return sinMarcasDeAdjunto(contenido).replace(
    /\[DOCUMENTO: [^\]]*\]/g,
    "(El cliente adjuntó un documento. No puedes abrirlo: ya se le pasó a una persona del equipo para " +
      "revisarlo. Díselo con calidez y NUNCA des por recibido un pago.)",
  );
}

/** Cada cuánto, como mucho, se avisa al dueño de los mensajes de una misma conversación. */
const AVISO_DE_MENSAJE_MS = 30 * 60_000;

/** Lo que recibe el cliente cuando ningún modelo pudo contestar. */
// De usted: es lo que eligió el dueño (Configuración → Trato al cliente).
const FALLO_DEL_MODELO = "Disculpe, algo falló de nuestro lado. Por favor, escríbanos de nuevo en un momento.";

/**
 * Un mensaje que lleva más que esto en el buffer no es de "el cliente sigue
 * escribiendo": es un resto de una pausa o de una caída. El buffer normal vive
 * entre 5 y 30 segundos.
 */
const BUFFER_VENCIDO_MS = 10 * 60_000;
import type { ChannelId } from "./channels/shared";

/**
 * Las tools que el modelo puede volver a usar al rehacer una respuesta que la
 * guardia de cifras detuvo: solo las que CONSULTAN. Las que hacen algo (abrir
 * un ticket, anotar un lead, pausar) ya corrieron en el primer intento, y
 * repetirlas duplicaría el lead o el aviso al dueño. Igual que en Baby Caleb.
 */
const TOOLS_DE_CONSULTA = new Set(["searchKb", "catalogQuery"]);

/** Índice = día de la semana tal como lo devuelve `localTime`. */
const DAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

export interface SupportAgentState {
  conversationId: string | null;
  channel: string;
  channelUserId: string;
  pendingMessages: { text: string; receivedAt: number }[];
  lastAlarmAt: number;
  lastUserLang: string;
  toolCallsInLast2Turns: number;
  lastSearchKbScore: number;
  imageRetryCount: number;
}

export interface AgentIncomingPayload {
  channel: string;
  channelUserId: string;
  displayName?: string;
  text?: string;
  audioUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  isOwnerMessage?: boolean;
  anuncio?: AnuncioEntrante;
}

export class SupportAgent extends Agent<Env, SupportAgentState> {
  initialState: SupportAgentState = {
    conversationId: null,
    channel: "",
    channelUserId: "",
    pendingMessages: [],
    lastAlarmAt: 0,
    lastUserLang: "es",
    toolCallsInLast2Turns: 0,
    lastSearchKbScore: 1,
    imageRetryCount: 0,
  };

  /**
   * El dueño borró esta conversación desde el panel: se tira el estado en
   * memoria (buffer y contadores) para que un mensaje nuevo empiece de cero y
   * no arrastre el contexto de un chat que ya no existe. Si había una alarma
   * pendiente, `processBuffer` la deja pasar sola: sin mensajes en el buffer,
   * corta al inicio.
   */
  async resetConversation(): Promise<{ ok: true }> {
    this.setState({ ...this.initialState });
    return { ok: true };
  }

  /**
   * Called by the Worker fetch handler when a webhook arrives for this user.
   * Buffers the message, schedules/resets an alarm.
   */
  async ingest(payload: AgentIncomingPayload): Promise<{ acknowledged: true }> {
    const db = new Db(this.env.DB);
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate(
      payload.channel,
      payload.channelUserId,
      payload.displayName,
    );
    this.setState({
      ...this.state,
      channel: payload.channel,
      channelUserId: payload.channelUserId,
      conversationId: conv.id,
    });

    // El clic del anuncio, para avisarle a Meta si se vuelve lead o venta
    // (src/meta/conversiones.ts). Antes de todo lo demás: también cuenta si la
    // conversación está en pausa.
    if (payload.anuncio?.ctwaClid) {
      await guardarClic(this.env, conv.id, payload.anuncio).catch((e) => console.warn("[meta] no se guardó el clic:", e));
    }

    // Una persona del equipo intervino → el bot se calla en esta conversación.
    // Su mensaje se anota como `owner` para que el panel muestre la
    // conversación completa, pero NO se procesa como si fuera del cliente.
    if (payload.isOwnerMessage) {
      if (payload.text?.trim()) {
        await new MessagesRepo(db).append(conv.id, "owner", payload.text.trim());
        await convs.touchLastMessage(conv.id);
      }
      await pausarPorHumano(this.env, conv.id);
      return { acknowledged: true };
    }

    // En pausa (una persona tiene la conversación): el bot no contesta, pero el
    // mensaje SÍ se guarda. Antes se tiraba, y el panel —desde donde se atiende—
    // mostraba la conversación sin lo que el cliente escribió mientras tanto.
    if (await convs.isPaused(conv.id)) {
      await this.anotarSinResponder(conv.id, payload);
      return { acknowledged: true };
    }

    // El bot entero en pausa desde el panel: mismo trato que una conversación
    // pausada. Antes el mensaje se quedaba en el buffer del Durable Object —fuera
    // de D1, invisible en el panel— y al despausar se contestaba TODO lo
    // acumulado de un golpe, días después, como si fuera un solo mensaje.
    const cfg = await resolveAgentConfig(this.env, []);
    if (cfg.botPaused) {
      await this.anotarSinResponder(conv.id, payload);
      return { acknowledged: true };
    }

    // Guardrail anti-spam: el mismo mensaje por 3ª vez entre los últimos 5 →
    // la conversación descansa 1 hora, sin respuesta y sin gastar LLM.
    if (payload.text && !payload.audioUrl && !payload.imageUrl && !payload.videoUrl) {
      try {
        const { isRepeatSpam, SPAM_SNOOZE_MS, isOverDailyCap, DAILY_CAP_SNOOZE_MS, DAILY_CAP_MESSAGE } =
          await import("./spam");
        if (await isRepeatSpam(db, conv.id, payload.text)) {
          await convs.setPausedUntil(conv.id, Date.now() + SPAM_SNOOZE_MS);
          console.warn(`[spam-guard] conv ${conv.id} en cooldown 1h (mensaje repetido)`);
          return { acknowledged: true };
        }
        // Tope diario de turnos: despedida amable UNA vez + descanso 12h. La
        // pausa garantiza que no se repita (los siguientes mensajes mueren en
        // isPaused antes de llegar aquí).
        if (await isOverDailyCap(db, conv.id)) {
          await convs.setPausedUntil(conv.id, Date.now() + DAILY_CAP_SNOOZE_MS);
          await new MessagesRepo(db).append(conv.id, "assistant", DAILY_CAP_MESSAGE);
          const channel = payload.channel as ChannelId;
          await pickAdapter(channel).sendReply(
            { channel, channelUserId: payload.channelUserId, chunks: [DAILY_CAP_MESSAGE] },
            this.env,
          );
          console.warn(`[spam-guard] conv ${conv.id} tope diario de turnos → descanso 12h`);
          return { acknowledged: true };
        }
      } catch (e) {
        // El guard es un extra, nunca la ruta crítica: si falla, se responde normal.
        console.warn("[spam-guard] check failed:", e);
      }
    }

    // Process media (audio → transcription, image → Pro-gated multimodal marker)
    let processedText = payload.text ?? "";
    let hasImage = false;

    // La foto, la nota de voz o el documento se guardan para el panel. La nota
    // de voz se transcribe con los mismos bytes: una sola descarga.
    const { marcas, audio } = await this.guardarAdjuntos(conv.id, payload);

    if (payload.audioUrl) {
      try {
        if (!audio) throw new Error("audio fetch failed");
        const { transcribirBytes } = await import("./media/transcribe");
        const result = await transcribirBytes(audio.bytes, this.env);
        processedText = result.text || "(audio sin transcripción)";
      } catch (e) {
        console.error("[ingest] transcription failed:", e);
        processedText = "(no pude entender el audio)";
      }
    }

    if (payload.imageUrl) {
      hasImage = true;
      // Pro-only: if free tier, strip the image and inform the bot owner-side
      if (!isPro(this.env)) {
        processedText =
          (processedText || "") +
          "\n(El cliente mandó una imagen, pero tu plan no soporta análisis de imágenes.)";
      } else {
        processedText =
          (processedText || "(imagen sin caption)") +
          `\n[IMAGE_URL: ${payload.imageUrl}]`;
      }
    }
    if (payload.videoUrl) {
      // El bot no ve videos: se le dice que llegó uno y que lo verá una persona.
      processedText = `${processedText ? `${processedText}\n` : ""}(El cliente mandó un video. No puedes verlo: el equipo lo revisa. Díselo con calidez.)`;
    }
    if (marcas.length) processedText = `${processedText}\n${marcas.join("\n")}`;

    // Append to buffer (we always persist the client's message)
    const pending = [
      ...this.state.pendingMessages,
      { text: processedText, receivedAt: Date.now() },
    ];
    this.setState({
      ...this.state,
      pendingMessages: pending,
      imageRetryCount: hasImage ? 0 : this.state.imageRetryCount,
    });

    // Schedule buffer processing via the agents SDK scheduler.
    // The SDK overrides alarm() to dispatch named callbacks from its
    // cf_agents_schedules table, so raw ctx.storage.setAlarm() alone won't
    // invoke our code. We upsert a fixed 'msg-buffer' row (so rapid messages
    // debounce to a single fire) and set the raw alarm as the trigger.
    const alarmAt = Date.now() + cfg.bufferMs;
    const alarmAtSec = Math.floor(alarmAt / 1000);
    this.sql`
      INSERT OR REPLACE INTO cf_agents_schedules
        (id, callback, payload, type, time, created_at)
      VALUES
        ('msg-buffer', 'processBuffer', '{}', 'delayed', ${alarmAtSec}, unixepoch())
    `;
    await this.ctx.storage.setAlarm(alarmAt);
    this.setState({ ...this.state, lastAlarmAt: alarmAt });

    return { acknowledged: true };
  }

  /**
   * La foto, la nota de voz y los documentos del mensaje, guardados para que el
   * dueño los vea y los escuche en el panel (src/media/adjuntos.ts). Devuelve
   * las marcas para el mensaje y los bytes del audio, para transcribirlo sin
   * descargarlo dos veces. Nunca rompe la respuesta: lo que no se pudo guardar
   * se queda sin marca.
   */
  private async guardarAdjuntos(
    convId: string,
    payload: AgentIncomingPayload,
  ): Promise<{ marcas: string[]; audio: { bytes: Uint8Array; mime: string } | null }> {
    const marcas: string[] = [];
    const guardar = async (url: string, tipo: TipoAdjunto, nombre: string | null = null) => {
      try {
        const archivo = await bytesDeMedia(this.env, url);
        if (!archivo) {
          marcas.push(marcaDeFallo(tipo, "descarga"));
          return null;
        }
        const id = await guardarAdjunto(this.env, convId, archivo, tipo, nombre);
        if (id) marcas.push(marcaDeAdjunto(id));
        else marcas.push(marcaDeFallo(tipo, archivo.bytes.byteLength > maximoDe(tipo) ? "grande" : "descarga"));
        return archivo;
      } catch (e) {
        console.warn(`[adjuntos] no se pudo descargar ${tipo}:`, e);
        // Que el panel lo diga: antes quedaba un hueco mudo.
        marcas.push(marcaDeFallo(tipo, "descarga"));
        return null;
      }
    };
    const audio = payload.audioUrl ? await guardar(payload.audioUrl, "audio") : null;
    if (payload.imageUrl) await guardar(payload.imageUrl, "imagen");
    if (payload.videoUrl) await guardar(payload.videoUrl, "video");
    for (const m of (payload.text ?? "").matchAll(/\[DOCUMENTO: (\S+?)(?: \| ([^\]]*))?\]/g)) {
      await guardar(m[1], "documento", m[2]?.trim() || null);
    }
    return { marcas, audio };
  }

  /**
   * Guarda el mensaje del cliente en D1 sin contestarlo: la conversación la
   * tiene una persona, o el bot está en pausa. El audio no se transcribe —cuesta
   * y nadie lo va a leer como texto—, se deja constancia de que llegó.
   */
  private async anotarSinResponder(convId: string, payload: AgentIncomingPayload): Promise<void> {
    const partes = [payload.text?.trim() ?? ""];
    if (payload.audioUrl) partes.push("(el cliente mandó un audio)");
    if (payload.imageUrl) partes.push("(el cliente mandó una imagen)");
    if (payload.videoUrl) partes.push("(el cliente mandó un video)");
    // Quien atiende desde el panel la ve y la escucha ahí mismo.
    partes.push(...(await this.guardarAdjuntos(convId, payload)).marcas);
    const texto = partes.filter(Boolean).join("\n");
    if (!texto) return;
    const db = new Db(this.env.DB);
    await new MessagesRepo(db).append(convId, "user", texto);
    const convs = new ConversationsRepo(db);
    await convs.touchLastMessage(convId);

    // Si el dueño está atendiendo ESTA conversación desde Telegram, lo que el
    // cliente escribe se le reenvía allá: así Telegram es una conversación de
    // ida y vuelta y no un aviso suelto. Desde el panel o el teléfono no hace
    // falta — ya lo está viendo.
    try {
      const conv = await convs.getById(convId);
      if (conv?.paused_until && conv.paused_until > Date.now() && viaDeAtencion(conv.metadata) === "telegram") {
        const { avisarAlDueno } = await import("./owner/avisos");
        // Con la foto, si mandó una: la dueña atiende desde Telegram y un
        // "(el cliente mandó una imagen)" sin la imagen no le sirve de nada.
        await avisarAlDueno(this.env, {
          titulo: "💬 Te escribió",
          cuerpo: texto,
          conversationId: convId,
          conBotones: "devolver",
          foto: payload.imageUrl ?? null,
        });
      }
    } catch (e) {
      console.warn("[SupportAgent] no se pudo reenviar a Telegram:", e);
    }
  }

  /**
   * El revisor detuvo una respuesta que no se pudo arreglar (un pago dado por
   * bueno, una frase que el dueño prohibió): se abre el ticket y se avisa al
   * dueño con lo que el bot iba a decir, para que conteste él. Si ya hay un
   * ticket abierto en la conversación, no se abre otro (openTicketAndNotify).
   */
  private async pasarAUnaPersonaPorRevisor(convId: string, borrador: string, problemas: Problema[]): Promise<void> {
    try {
      const { openTicketAndNotify } = await import("./tools/escalate");
      const motivo = problemas.map((p) => p.codigo).join(", ");
      await openTicketAndNotify(this.env, convId, {
        reason: "respuesta detenida",
        summary: `El bot iba a decir algo que no debe (${motivo}) y no lo mandó. Lo que iba a decir: «${borrador.slice(0, 300)}»`,
        category: problemas.some((p) => p.codigo === "pago-confirmado") ? "billing" : "other",
      });
    } catch (e) {
      console.error("[revisor] no se pudo abrir el ticket:", e);
    }
  }

  /** ¿Hay una persona a cargo, o el bot entero está apagado desde el panel? */
  private async hayQueCallarse(convId: string): Promise<boolean> {
    const db = new Db(this.env.DB);
    if (await new ConversationsRepo(db).isPaused(convId)) return true;
    return (await resolveAgentConfig(this.env, [])).botPaused;
  }

  /**
   * Called by the agents SDK scheduler when the msg-buffer task fires.
   * Processes accumulated messages as one input, runs the LLM loop, and
   * sends the chunked reply over the channel adapter.
   */
  async processBuffer(): Promise<void> {
    const pendientes = [...this.state.pendingMessages];
    this.setState({ ...this.state, pendingMessages: [] });
    if (pendientes.length === 0) return;

    const db = new Db(this.env.DB);
    const msgs = new MessagesRepo(db);
    const convs = new ConversationsRepo(db);
    const convId = this.state.conversationId;
    if (!convId) {
      console.warn("[SupportAgent.processBuffer] no conversation_id in state");
      return;
    }

    // Lo vencido se anota pero no se contesta. Son restos de antes de este
    // arreglo (la pausa global dejaba todo en el buffer) o de una caída: al
    // volver, el bot respondía de un golpe mensajes de hace días como si el
    // cliente los acabara de escribir.
    const recibidoHasta = Date.now();
    const vencidos = pendientes.filter((m) => recibidoHasta - m.receivedAt > BUFFER_VENCIDO_MS);
    for (const m of vencidos) {
      if (m.text.trim()) await msgs.append(convId, "user", m.text.trim(), { createdAt: m.receivedAt });
    }
    const buffered = pendientes.filter((m) => recibidoHasta - m.receivedAt <= BUFFER_VENCIDO_MS);
    if (buffered.length === 0) return;

    // Entre que llegó el mensaje y que venció la espera del buffer, una
    // persona pudo haber tomado la conversación (contestó desde el teléfono,
    // desde el panel). Si es así, el mensaje se guarda y el bot no se mete.
    if (await this.hayQueCallarse(convId)) {
      for (const m of buffered) {
        if (m.text.trim()) await msgs.append(convId, "user", m.text.trim(), { createdAt: m.receivedAt });
      }
      return;
    }

    const combined = buffered.map((m) => m.text).join("\n").trim();
    if (!combined) return;

    // Persist user message
    await msgs.append(convId, "user", combined);
    await convs.touchLastMessage(convId);

    // ¿Viene a comprar? Un préstamo, un empleo, un toque sin querer o dos
    // saludos sin nada más (src/noCliente.ts). Con la marca, el bot cierra con
    // amabilidad, no se anota lead, Meta no se entera y no hay seguimiento.
    let noCliente: MotivoNoCliente | null = null;
    try {
      noCliente = await revisarNoCliente(db, convId);
    } catch (e) {
      console.warn("[SupportAgent] no se pudo revisar si es cliente:", e);
    }

    // Load history (last 20)
    const history = await msgs.lastN(convId, 20);
    const aiMessages: any[] = history.slice(0, -1).map((m) =>
      // Una nota interna del equipo es contexto, no algo que el bot dijo: va como
      // mensaje de usuario, marcada, para que no la repita al cliente.
      m.role === "owner" && esNotaInterna(m.content)
        ? { role: "user" as const, content: notaParaElModelo(m.content) }
        : {
            role: (m.role === "tool" ? "user" : m.role === "owner" ? "assistant" : m.role) as "user" | "assistant",
            content: paraElModelo(m.content),
          },
    );
    // Build the LAST user message multimodal-aware: if it carries an
    // [IMAGE_URL: ...] marker AND we're on the Pro tier, attach the image.
    //
    // La imagen va en BYTES, leída por el CRM (ver imagenParaElModelo). Si no
    // se pudo abrir, el modelo lo sabe y atiende al cliente igual.
    const lastUserMsg = history[history.length - 1];
    let textoSinImagen: string | null = null;
    if (lastUserMsg) {
      const imgMatch = lastUserMsg.content.match(/\[IMAGE_URL: (.+?)\]/);
      if (imgMatch && isPro(this.env)) {
        const cleanText = paraElModelo(lastUserMsg.content.replace(/\n?\[IMAGE_URL: .+?\]/, "")).trim();
        textoSinImagen = `${cleanText || "(sin texto)"}\n\n${NOTA_IMAGEN_ILEGIBLE}`;
        const img = await imagenParaElModelo(this.env, imgMatch[1]);
        aiMessages.push(img ? mensajeConImagen(cleanText, img) : { role: "user", content: textoSinImagen });
        if (!img) textoSinImagen = null; // ya va sin imagen: no hay a qué caer
      } else {
        aiMessages.push({ role: "user", content: paraElModelo(lastUserMsg.content) });
      }
    }

    // Build tools registry (tier-gated in buildTools)
    const tools = buildTools({
      env: this.env,
      getConversationId: () => convId,
    });
    const toolNames = Object.keys(tools);

    // Resolve effective config (D1 settings overlaid on env defaults).
    const cfg = await resolveAgentConfig(this.env, toolNames);

    // Temas que el dueño quiere saber siempre (factura, contrato, legal,
    // reembolso, cotización, "ya pagué", "quiero contratar", pide una persona,
    // manda una imagen). Corre ANTES del LLM y sin depender de qué tool elija:
    // así fue como un handoff real se perdió en silencio. No pausa al bot —
    // el cliente sigue atendido mientras el dueño se entera. Si el modelo
    // además escala, openTicketAndNotify reutiliza el mismo ticket.
    try {
      const { detectEscalation, stripMarkers } = await import("./escalation-triggers");
      const hit = detectEscalation(combined, cfg.escalationKeywords);
      if (hit) {
        const { openTicketAndNotify } = await import("./tools/escalate");
        const { notified } = await openTicketAndNotify(this.env, convId, {
          reason: hit.label,
          summary: stripMarkers(combined) || hit.matched,
          category: hit.category,
        });
        if (notified) console.log(`[escalation-trigger] ${hit.id} en conv ${convId} — dueño avisado`);
      }
    } catch (e) {
      // El aviso es un extra sobre la respuesta, nunca al revés: si falla,
      // el cliente igual recibe su contestación.
      console.error("[escalation-trigger] falló el aviso automático:", e);
    }

    // Cada mensaje nuevo, al Telegram del dueño (pedido del dueño, 25-oct-2026):
    // uno por conversación cada media hora, para que una charla activa no le
    // llene el teléfono. Si en este turno ya salió un aviso (un ticket, un lead),
    // ese cuenta y no se repite.
    try {
      const { avisoReciente } = await import("./owner/acciones");
      if (!(await avisoReciente(this.env, convId, AVISO_DE_MENSAJE_MS))) {
        const { stripMarkers } = await import("./escalation-triggers");
        const { avisarAlDueno } = await import("./owner/avisos");
        const delAnuncio = /\[ANUNCIO: /.test(combined) ? "\n📣 Llegó desde un anuncio." : "";
        await avisarAlDueno(this.env, {
          titulo: "💬 Mensaje nuevo",
          cuerpo: `${stripMarkers(combined, 400) || "(sin texto)"}${delAnuncio}`,
          conversationId: convId,
        });
      }
    } catch (e) {
      console.warn("[SupportAgent] no se pudo avisar del mensaje nuevo:", e);
    }

    // Honor the dashboard's tool toggles: the prompt already only advertises
    // enabled tools (settings-loader), so the registry must match.
    const enabledTools = Object.fromEntries(
      Object.entries(tools).filter(([name]) => cfg.enabledToolNames.includes(name)),
    );

    // Select tier: honor an explicit override, otherwise auto-select. The active
    // provider (Anthropic default | OpenAI) maps the tier to a concrete model id.
    let tier: Tier =
      cfg.modelOverride === "haiku"
        ? "fast"
        : cfg.modelOverride === "sonnet"
          ? "smart"
          : selectModel({
              toolCallsInLast2Turns: this.state.toolCallsInLast2Turns,
              lastUserText: combined,
              lastUserLang: this.env.BOT_LANGUAGE,
              hasImage: false,
              imageRetryCount: this.state.imageRetryCount,
              lastSearchKbScore: this.state.lastSearchKbScore,
            });

    // Budget guard: at/over the monthly AI budget the bot keeps answering but
    // only on the cheap tier (never goes silent over money).
    if (cfg.monthlyBudgetUsd !== undefined && tier !== "fast") {
      const spent = await monthIaCostUsd(db);
      const guard = applyBudgetGuard(tier, spent, cfg.monthlyBudgetUsd);
      if (guard.downgraded) {
        console.warn(
          `[SupportAgent] monthly budget reached ($${spent.toFixed(2)}/$${cfg.monthlyBudgetUsd}) — downgrading to fast tier`,
        );
      }
      tier = guard.tier;
    }

    const { model, modelId, supportsPromptCache } = createModel(this.env, tier, cfg.llm);

    // Cache the (large, stable) system prompt with an ephemeral cache breakpoint.
    // Only the system block is cached — messages change every turn. Cache hits
    // show up in usage.cachedInputTokens (read below for cost accounting).
    // Prompt caching is Anthropic-only; on OpenAI we send the plain system block.
    const system: SystemModelMessage[] = [
      {
        role: "system",
        content: cfg.systemPrompt,
        ...(supportsPromptCache
          ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
          : {}),
      },
    ];

    /*
     * Qué hora es donde está el negocio, y si hay alguien del equipo ahora.
     *
     * Va en un bloque APARTE y SIN cachear, pegado al de <cliente>: el prompt
     * grande de arriba se cachea porque no cambia, y meter aquí una hora que
     * cambia cada minuto invalidaría esa caché en cada mensaje.
     *
     * Sin esto, el bot prometía a las 2 de la mañana de un domingo que "alguien
     * te contesta enseguida". Un modelo no sabe qué hora es si no se le dice.
     */
    const ahora = localTime(new Date(), cfg.timezone);
    const disponible = isWithinBusinessHours(new Date(), cfg.timezone, cfg.businessHours);
    system.push({
      role: "system",
      content:
        `<ahora>\n` +
        `Hora local del negocio: ${ahora.clock} (${cfg.timezone}), ${DAY_NAMES[ahora.weekday]}.\n` +
        (disponible
          ? "Hay alguien del equipo disponible: si escalas, le responden hoy."
          : "FUERA DE HORARIO: no hay nadie del equipo ahora. Tú atiendes igual, pero si " +
            "escalas dile cuándo le responde una persona, según el horario del negocio.") +
        `\n</ahora>`,
    });

    // Por dónde escribe el cliente y, si el canal lo trae, su número. Sin
    // esto, el bot le pedía el teléfono a quien le escribía por WhatsApp.
    // Bloque aparte y sin cachear, como <ahora>: cambia con cada cliente.
    const telefono = telefonoDelCliente(this.state.channel, this.state.channelUserId);
    system.push({
      role: "system",
      content:
        // Sin el "(QR)" de la etiqueta del panel: es un detalle interno que el
        // bot no tiene por qué repetirle al cliente.
        `<canal>\nEl cliente te escribe por ${channelLabel(this.state.channel).replace(/\s*\(QR\)$/, "")}.` +
        (telefono
          ? ` Su número es ${telefono}: ya lo tienes, no se lo pidas. Si anotas el lead con captureLead, ese es su contacto.`
          : "") +
        (esWhatsApp(this.state.channel)
          ? "\nEs WhatsApp: mensajes cortos, como en un chat con alguien de confianza; negrita con UN asterisco (*así*), sin títulos ni tablas."
          : "") +
        `\n</canal>`,
    });

    if (noCliente) system.push({ role: "system", content: notaParaElBot(noCliente) });

    // Customer memory (flywheel): facts extracted by the insights analyzer are
    // injected as a small UNCACHED system block, so a returning customer is
    // greeted by a bot that remembers them. The big prompt above stays cached.
    // Memory is an enhancement, never the critical path: if the lookup fails,
    // the reply still goes out.
    try {
      const facts = await new CustomerFactsRepo(db).forConversation(convId, 8);
      if (facts.length > 0) {
        system.push({
          role: "system",
          content: `<cliente>\nLo que ya sabes de este cliente (de conversaciones pasadas):\n${facts
            .map((f) => `- ${f.fact}`)
            .join("\n")}\n</cliente>`,
        });
      }
    } catch (e) {
      console.warn("[SupportAgent] customer facts lookup failed:", e);
    }

    let assistantText = "";
    let usage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    // Todo intento que alcanzó a consumir tokens se factura, aunque después
    // haya fallado y se reintentara con otro modelo: el proveedor ya lo cobró.
    const billed: { model: string; usage: TokenUsage }[] = [];
    let toolCallCount = 0;
    let toolCallsMade: { toolName: string; input: unknown }[] = [];
    let usedModelId = modelId;
    // El modelo que de verdad contestó: si hubo failover, la reescritura por
    // cifras tiene que salir por el mismo sitio y no por el que acaba de fallar.
    let usedModel: any = model;
    /*
     * Lo que el bot LEYÓ este turno: cada trozo que devolvió searchKb, con su
     * título. Es contra esto —y contra el contexto del negocio— que se valida
     * que no se haya inventado un precio. Se acumula entre intentos: lo leído
     * en el primero sigue siendo válido en la reescritura.
     */
    const pasajesLeidos: string[] = [];

    // Corre el loop del LLM con un modelo dado; deja los resultados en las vars.
    const attempt = async (m: any, attemptModelId: string, toolset: Record<string, any> = enabledTools) => {
      const result = streamText({
        model: m,
        system,
        messages: aiMessages,
        tools: toolset,
        // Opciones por proveedor: con Meta, sin `eager_input_streaming` en las tools.
        providerOptions: OPCIONES_POR_PROVEEDOR,
        stopWhen: ({ steps }) => steps.length >= 6,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      });
      try {
        let text = "";
        for await (const chunk of result.textStream) {
          text += chunk;
        }
        assistantText = text;
      } finally {
        // `result.usage` es solo el ÚLTIMO paso: con herramientas se quedaban
        // fuera todas las llamadas intermedias (hasta 6 por respuesta).
        // `totalUsage` las suma. Se lee aunque el stream reviente a media
        // respuesta — lo que ya se consumió, ya se cobró.
        // La carrera contra el reloj es a propósito: si el stream murió, la
        // promesa de usage puede quedarse sin resolver, y la contabilidad NO
        // puede dejar al cliente esperando ni bloquear el failover.
        const totals = await Promise.race([
          Promise.resolve(result.totalUsage).catch(() => undefined),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
        ]);
        if (totals) {
          usage = usageFromSdk(totals);
          billed.push({ model: attemptModelId, usage });
        }
      }
      const steps = await result.steps;
      // Lo que el modelo dice ANTES de llamar una tool («busco la info del
      // plan…») es narración, no respuesta: con Muse Spark salía pegado al
      // «¡Hola!» en cada mensaje (25-oct-2026). Se quita solo si es corto y
      // después vino la respuesta de verdad; si el modelo contestó y DESPUÉS
      // llamó una tool (anotar el lead), ese texto se queda.
      const recortado = sinNarracion(steps as any[]);
      if (recortado) assistantText = recortado;
      toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
      // Persist what the agent DID (not just what it said): tool name + input,
      // feeding the dashboard's thread chips, stats and the Mi Agente counters.
      toolCallsMade = steps.flatMap((s) =>
        (s.toolCalls ?? []).map((tc: any) => ({
          toolName: tc.toolName as string,
          input: tc.input,
        })),
      );
      for (const step of steps) {
        for (const tr of ((step as any).toolResults ?? []) as any[]) {
          // `output` en el SDK nuevo, `result` en el viejo: se aceptan los dos
          // para que una subida de versión no deje el guardián ciego en silencio.
          pasajesLeidos.push(
            ...pasajesDeHerramienta(tr?.toolName, tr?.output ?? tr?.result),
          );
        }
      }
    };

    try {
      await attempt(model, modelId);
    } catch (e: any) {
      // FAILOVER con backoff: en ráfagas (historias) el primario suele dar un
      // rate-limit TRANSITORIO — esperar con jitter y reintentar resuelve la
      // mayoría; si no, se prueba el proveedor alterno (también con un segundo
      // intento). El jitter des-sincroniza mensajes que llegaron en el mismo
      // segundo. El bot no puede quedarse mudo el día del evento.
      console.error("[SupportAgent.processBuffer] streamText failed:", e);
      // El error REAL, para Config: sin esto solo queda en los logs de Cloudflare.
      const falloReal = describirError(e, secretosDelEntorno(this.env, cfg.llm?.apiKey));
      const backoff = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const { fallbackModel } = await import("./llm/provider");
      const primary = createModel(this.env, tier, cfg.llm);
      const fb = fallbackModel(this.env, tier, primary.provider);
      let ok = false;

      await backoff(2000 + Math.floor(Math.random() * 1500));
      try {
        await attempt(model, modelId);
        ok = true;
      } catch (e1: any) {
        console.error("[SupportAgent.processBuffer] primary retry failed:", e1);
      }

      if (!ok && fb) {
        console.warn(
          `[SupportAgent] failover ${primary.provider} → ${fb.provider}/${fb.modelId}`,
        );
        try {
          await attempt(fb.model, fb.modelId);
          usedModelId = fb.modelId;
          usedModel = fb.model;
          ok = true;
        } catch (e2: any) {
          console.error("[SupportAgent.processBuffer] fallback failed:", e2);
          await backoff(2500 + Math.floor(Math.random() * 1500));
          try {
            await attempt(fb.model, fb.modelId);
            usedModelId = fb.modelId;
            usedModel = fb.model;
            ok = true;
          } catch (e3: any) {
            console.error("[SupportAgent.processBuffer] fallback retry failed:", e3);
          }
        }
      }

      // Con una imagen de por medio, un último intento SIN ella: que el
      // proveedor no pueda procesar la foto no es razón para dejar al cliente
      // con "algo falló". Se le atiende diciéndole que no se abrió.
      if (!ok && textoSinImagen) {
        aiMessages[aiMessages.length - 1] = { role: "user", content: textoSinImagen };
        try {
          await attempt(model, modelId);
          ok = true;
        } catch (e4: any) {
          console.error("[SupportAgent.processBuffer] sin la imagen también falló:", e4);
        }
      }

      await anotarFalloLlm(this.env, {
        cuando: Date.now(),
        proveedor: primary.provider,
        modelo: modelId,
        mensaje: falloReal,
        recuperado: ok,
        respaldo: ok && usedModelId !== modelId ? usedModelId : undefined,
      });

      if (!ok) {
        assistantText = FALLO_DEL_MODELO;
      }
    }

    // Las tools que se pueden volver a usar al rehacer una respuesta (revisor o
    // guardia de cifras): solo las que consultan.
    const consulta = Object.fromEntries(
      Object.entries(enabledTools).filter(([name]) => TOOLS_DE_CONSULTA.has(name)),
    );

    /*
     * El revisor (src/replies/revisor.ts, traído de Baby Caleb): lo que la
     * respuesta NO puede decir —un pago dado por recibido, un cupo «reservado»,
     * una fecha prometida, una frase que el dueño prohibió—. Si encuentra algo,
     * el modelo la rehace UNA vez con la lista delante; si lo que bloquea sigue
     * ahí, no sale y la conversación pasa a una persona. Va antes de la guardia
     * de cifras, que revisa lo que quede. Es un extra: si falla, la respuesta
     * sigue su camino.
     */
    const anterioresDelBot = history
      .filter((m) => m.role === "assistant")
      .slice(-2)
      .reverse()
      .map((m) => m.content);
    const contextoRevision = {
      frasesProhibidas: cfg.frasesProhibidas,
      textoDelCliente: combined,
      respuestasAnteriores: anterioresDelBot,
      // La primera respuesta a quien tocó un anuncio: 2 líneas y una pregunta.
      primeraDelAnuncio:
        esAperturaDeAnuncio(combined) && !history.some((m) => m.role === "assistant" || m.role === "owner"),
      // De usted: que no se le cuele un tuteo (Configuración → Trato al cliente).
      formaDeTrato: cfg.formaDeTrato,
    };
    let detenidaPorRevisor = false;
    if (assistantText.trim() && assistantText !== FALLO_DEL_MODELO) {
      try {
        const revision = revisarRespuesta(assistantText, contextoRevision);
        if (revision.length > 0) {
          console.warn(`[revisor] conv ${convId}: ${revision.map((p) => p.codigo).join(", ")} — se rehace`);
          const borrador = assistantText;
          const nota: SystemModelMessage = {
            role: "system",
            content: notaDeRevision(borrador, revision, pasajesLeidos.join("\n\n")),
          };
          system.push(nota);
          // Lo que hizo el primer intento (un lead, un ticket) ya pasó: se suma.
          const llamadasPrevias = toolCallsMade;
          const cuentaPrevia = toolCallCount;
          toolCallsMade = [];
          toolCallCount = 0;
          try {
            await attempt(usedModel, usedModelId, consulta);
          } catch (e) {
            console.error("[revisor] no se pudo rehacer la respuesta:", e);
            assistantText = "";
          }
          toolCallsMade = [...llamadasPrevias, ...toolCallsMade];
          toolCallCount = cuentaPrevia + toolCallCount;
          // La nota era para esta reescritura, no para la de cifras.
          system.splice(system.indexOf(nota), 1);
          const despues = assistantText.trim() ? revisarRespuesta(assistantText, contextoRevision) : revision;
          if (hayQueBloquear(despues)) {
            console.warn(`[revisor] conv ${convId}: sigue ${despues.map((p) => p.codigo).join(", ")} — no sale, pasa a una persona`);
            assistantText = RESPUESTA_SEGURA;
            detenidaPorRevisor = true;
            await this.pasarAUnaPersonaPorRevisor(convId, borrador, despues);
          } else if (!assistantText.trim()) {
            // No se pudo rehacer y nada bloqueaba: sale la original.
            assistantText = borrador;
          }
          // Queda a la vista en el hilo del panel, como una tool más.
          toolCallsMade = [
            ...toolCallsMade,
            { toolName: "revisor", input: { corrigio: revision.map((p) => p.codigo), bloqueo: detenidaPorRevisor } },
          ];
        }
      } catch (e) {
        console.error("[revisor] falló; la respuesta sigue sin revisar:", e);
      }
    }

    /*
     * Guardia de cifras — la última puerta antes del cliente.
     *
     * El prompt ya prohíbe inventar precios en tres sitios distintos y aun así
     * el bot ofreció el chatbot "por $70 pago único" cuando el precio publicado
     * es $499: no tenía el dato a mano, improvisó la respuesta entera y la
     * cifra salió con ella. Un ruego dentro del prompt se cumple casi siempre,
     * y el "casi" lo paga el cliente que repite el número equivocado.
     *
     * Aquí se compara cada importe contra lo que el bot leyó ESTE turno. Si
     * alguno no tiene de dónde haberse copiado, se le devuelve con el fallo
     * señalado y una orden de buscarlo; si insiste, no sale. Antes que un
     * precio inventado, un "deja que te lo confirme una persona".
     */
    const { pasajes, vocabulario } = fuentesDelPrompt(cfg.systemPrompt, this.env.BUSINESS_NAME);
    // Lo que el cliente escribió en este turno también respalda una cifra: si
    // dice "le transferí $300", repetirle "$300" no es inventar.
    const delCliente = combined.replace(/\[[A-Z_]+: [^\]]*\]/g, "");
    // Y lo que ya se dijo en esta conversación: las respuestas anteriores del
    // bot (que ya pasaron por aquí) y, sobre todo, lo que escribió una persona
    // del equipo. Si el dueño le dio una cifra al cliente, el bot puede
    // repetirla. Es lo que hace Juan en D'Casa ("cifras conocidas").
    const yaDicho = history
      .slice(0, -1)
      .filter((m) => m.role === "assistant" || m.role === "owner")
      .map((m) => m.content);
    const fuentes = () => [...pasajes, ...pasajesLeidos, ...yaDicho, delCliente];
    // Con una foto (un comprobante, casi siempre) el modelo lee el monto de la
    // imagen, y esa cifra no está en ningún texto: la guardia la tomaba por
    // inventada y al cliente que mandó su pago le llegaba "prefiero no darte un
    // número que no tenga confirmado" (24-sep-2026, PanaClaw).
    const conImagen = /\[IMAGE_URL: /.test(combined);
    const revision = revisarCifras(assistantText, fuentes(), vocabulario);
    if (revision.sinRespaldo.length > 0) {
      const borrador = assistantText;
      console.error(
        `[SupportAgent] cifra sin respaldo (${revision.sinRespaldo.join(", ")}) en conv ${convId} — reescribiendo. ` +
          `Frases: ${revision.frases.map((f) => `«${f}»`).join(" ")}`,
      );
      system.push({
        role: "system",
        content: avisoDeCifrasInventadas(revision.sinRespaldo, conImagen, revision.frases),
      });
      // Lo que hizo el primer intento ya pasó (un lead anotado, un ticket): se
      // suma a lo de la reescritura, para que el panel y el selector de modelo
      // no lo pierdan. La reescritura solo consulta, así que no lo repite.
      const llamadasPrevias = toolCallsMade;
      const cuentaPrevia = toolCallCount;
      toolCallsMade = [];
      toolCallCount = 0;
      try {
        await attempt(usedModel, usedModelId, consulta);
      } catch (e) {
        console.error("[SupportAgent] reescritura por cifras falló:", e);
        assistantText = "";
      }
      toolCallsMade = [...llamadasPrevias, ...toolCallsMade];
      toolCallCount = cuentaPrevia + toolCallCount;
      const siguen = revisarCifras(assistantText, fuentes(), vocabulario);
      if (!assistantText.trim() || siguen.sinRespaldo.length > 0) {
        // Si insiste, se quita la frase y el resto sale (como Juan en
        // D'Casa). Antes se tiraba la respuesta entera: el cliente del
        // anuncio recibía "prefiero no darte un número" en vez del plan.
        const base = assistantText.trim() ? assistantText : borrador;
        const frases = assistantText.trim() ? siguen.frases : revision.frases;
        const recortada = sinFrasesSinRespaldo(base, frases);
        console.error(
          `[SupportAgent] la reescritura sigue sin respaldo (${siguen.sinRespaldo.join(", ")}) — ` +
            (recortada ? "se manda sin esas frases" : "se manda la respuesta sin cifra"),
        );
        if (recortada) {
          assistantText = recortada;
        } else {
          assistantText = conImagen ? RESPUESTA_SIN_CIFRA_CON_IMAGEN : RESPUESTA_SIN_CIFRA;
          // Esa respuesta promete que una persona del equipo contesta. Sin
          // ticket ni aviso, nadie se enteraba y el cliente esperaba en vano.
          try {
            const { openTicketAndNotify } = await import("./tools/escalate");
            await openTicketAndNotify(this.env, convId, {
              reason: "el bot no pudo dar una cifra",
              summary:
                `El cliente escribió: «${delCliente.trim().slice(0, 300)}». El bot iba a contestar con una cifra ` +
                `que no encontró publicada y no la mandó. Lo que iba a decir: «${borrador.slice(0, 300)}»`,
              category: "other",
            });
          } catch (e) {
            console.error("[SupportAgent] no se pudo avisar al dueño de la cifra detenida:", e);
          }
        }
      }
    }

    // La guardia de cifras pudo reescribir la respuesta: lo que bloquea se
    // vuelve a mirar en el texto que de verdad va a salir.
    if (!detenidaPorRevisor && assistantText.trim() && assistantText !== FALLO_DEL_MODELO) {
      const finales = revisarRespuesta(assistantText, contextoRevision);
      if (hayQueBloquear(finales)) {
        const borrador = assistantText;
        console.warn(`[revisor] conv ${convId}: la reescritura por cifras trajo ${finales.map((p) => p.codigo).join(", ")} — no sale`);
        assistantText = RESPUESTA_SEGURA;
        await this.pasarAUnaPersonaPorRevisor(convId, borrador, finales);
      }
    }

    // Última puerta: el modelo tarda segundos, y en esos segundos una persona
    // pudo haber contestado. Si ya hay alguien a cargo, la respuesta del bot no
    // sale — mandarla sería justo el choque que esto existe para evitar. Lo
    // gastado en IA se anota igual: el proveedor ya lo cobró.
    if (await this.hayQueCallarse(convId)) {
      const base = crypto.randomUUID();
      for (const [i, entry] of billed.entries()) {
        await recordAiUsage(db, {
          id: i === 0 ? base : `${base}:${i}`,
          source: "chat",
          conversationId: convId,
          model: entry.model,
          usage: entry.usage,
        });
      }
      console.log(`[SupportAgent] conv ${convId}: una persona tomó la conversación mientras el bot pensaba — no se envía`);
      return;
    }

    // En WhatsApp, la negrita es con un asterisco y los títulos no existen: se
    // guarda igual a como sale, para que el panel muestre lo que vio el cliente.
    if (esWhatsApp(this.state.channel)) assistantText = formatoWhatsApp(assistantText);
    // De usted, sin emojis (2-nov-2026: el dueño pidió un bot más profesional).
    // De tú, como mucho uno y no en dos mensajes seguidos.
    assistantText =
      cfg.formaDeTrato === "usted"
        ? quitarEmojis(assistantText)
        : dosificarEmojis(assistantText, tieneEmoji(anterioresDelBot[0] ?? ""));

    // Persist assistant message (with usage + model_used + tool calls)
    const assistantMsgId = await msgs.append(convId, "assistant", assistantText, {
      modelUsed: usedModelId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cacheRead,
      toolCalls: toolCallsMade.length > 0 ? toolCallsMade : undefined,
    });

    // Libro de gasto: una fila por intento facturado. La primera lleva el id
    // del mensaje, así el backfill del esquema nunca la duplica.
    for (const [i, entry] of billed.entries()) {
      await recordAiUsage(db, {
        id: i === 0 ? assistantMsgId : `${assistantMsgId}:${i}`,
        source: "chat",
        conversationId: convId,
        model: entry.model,
        usage: entry.usage,
      });
    }

    // Update state for next turn
    this.setState({
      ...this.state,
      toolCallsInLast2Turns: toolCallCount,
    });

    // Chunk + send via the channel adapter
    const chunks = chunkReply(assistantText, cfg.maxChunks);
    const channel = this.state.channel as ChannelId;
    const adapter = pickAdapter(channel);
    await adapter.sendReply(
      {
        channel,
        channelUserId: this.state.channelUserId,
        chunks,
        interChunkDelayMs: cfg.interChunkDelayMs,
      },
      this.env,
    );

    console.log(
      `[SupportAgent.processBuffer] sent ${chunks.length} chunks, model=${usedModelId}, cost=$${costOfUsage(
        usedModelId,
        { input: usage.input, cached: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output },
      ).toFixed(5)}`,
    );
  }
}
