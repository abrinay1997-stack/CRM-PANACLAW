/**
 * La consola del dueño por Telegram, de punta a punta: vincular sin terminal,
 * responder sobre un aviso y los botones. PanaClaw no tiene inventario (esa
 * extensión vive en Baby Caleb). D1 real con Miniflare; la API de Telegram y el
 * puente de WhatsApp son dobles que anotan lo que se les mandó.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { ConversationsRepo } from "../../src/db/conversations";
import { MessagesRepo } from "../../src/db/messages";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import { atenderAlDueno, partirComando, type TgUpdate } from "../../src/owner/consola";
import { crearCodigoDeVinculo, chatDelDueno, canjearCodigo } from "../../src/owner/dueno";
import { avisarAlDueno } from "../../src/owner/avisos";

vi.mock("agents", () => ({ Agent: class {} }));

// El modelo del asistente del dueño, cuando una prueba lo necesita: anota lo
// que recibió y contesta lo que se le diga. Apagado, es el de verdad.
const llm = vi.hoisted(() => ({ activo: false, respuesta: "", llamadas: [] as any[] }));
vi.mock("ai", async (original) => {
  const real: any = await original();
  return {
    ...real,
    generateText: async (args: any) => {
      if (!llm.activo) return real.generateText(args);
      llm.llamadas.push(args);
      return { text: llm.respuesta };
    },
  };
});

const DUENO = 777;
/** Updates con la firma de Telegram. Los sin firma tienen su propia prueba. */
const OK = { confiable: true };
let env: any;
let db: Db;
let enviados: { metodo: string; cuerpo: any }[];
let siguienteId: number;
let alPuente: any[];

function stubTelegram() {
  enviados = [];
  siguienteId = 100;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("/file/bot")) return new Response(new Uint8Array([79, 103, 103, 83]));
    const metodo = u.split("/").pop()!.split("?")[0];
    let cuerpo: any = {};
    if (init?.body instanceof FormData) cuerpo = Object.fromEntries([...init.body.keys()].map((k) => [k, true]));
    else if (init?.body) cuerpo = JSON.parse(String(init.body));
    enviados.push({ metodo, cuerpo });
    if (metodo === "getFile") return Response.json({ ok: true, result: { file_path: "voice/file_1.oga" } });
    if (metodo === "getMe") return Response.json({ ok: true, result: { username: "PanaClawBot" } });
    if (metodo === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (metodo === "setWebhook") return Response.json({ ok: true, result: true });
    return Response.json({ ok: true, result: { message_id: siguienteId++ } });
  });
}

function mensaje(texto: string, extra: Record<string, unknown> = {}, de = DUENO): TgUpdate {
  return {
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: de, first_name: "Dueño" },
      chat: { id: de, type: "private" },
      text: texto,
      ...extra,
    },
  };
}

function boton(data: string, messageId = 55, de = DUENO): TgUpdate {
  return {
    callback_query: {
      id: "cb1",
      from: { id: de },
      data,
      message: { message_id: messageId, chat: { id: de }, text: "texto original" },
    },
  };
}

const textos = (metodo = "sendMessage") => enviados.filter((e) => e.metodo === metodo).map((e) => e.cuerpo.text as string);
const ultimoTeclado = () => {
  const m = [...enviados].reverse().find((e) => e.cuerpo.reply_markup?.inline_keyboard?.length);
  return (m?.cuerpo.reply_markup.inline_keyboard ?? []).flat() as { text: string; callback_data?: string }[];
};
const datoDe = (texto: string) => ultimoTeclado().find((b) => b.text.includes(texto))!.callback_data!;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  alPuente = [];
  env = {
    DB: d1,
    TELEGRAM_BOT_TOKEN: "tg-token",
    BUSINESS_NAME: "PanaClaw",
    BOT_NAME: "PanaClaw",
    BOT_TIER: "pro",
    DASHBOARD_BASE_URL: "https://bot.ejemplo",
    WA_TOKEN: "token-de-prueba-1234567890abcdef",
    WA_PUENTE_URL: "https://puente.ejemplo",
    PUENTE_WA: {
      fetch: async (req: Request) => {
        alPuente.push(await req.json());
        return Response.json({ ok: true });
      },
    },
  };
  stubTelegram();
});

afterEach(() => {
  vi.restoreAllMocks();
  llm.activo = false;
  llm.respuesta = "";
  llm.llamadas = [];
});

async function vincular() {
  await new SettingsRepo(db).set(SETTING_KEYS.ownerTelegramChatId, String(DUENO));
}

describe("vincular el Telegram del dueño sin terminal", () => {
  it("el enlace del panel (/start dueno_<código>) deja el chat como el del dueño", async () => {
    const { codigo } = await crearCodigoDeVinculo(env);
    expect(await atenderAlDueno(env, mensaje(`/start dueno_${codigo}`), OK)).toBe(true);
    expect(await chatDelDueno(env)).toBe(String(DUENO));
    expect(textos()[0]).toMatch(/Listo/);
  });

  it("el código es de un solo uso", async () => {
    const { codigo } = await crearCodigoDeVinculo(env);
    expect(await canjearCodigo(env, codigo, 1)).toBe(true);
    expect(await canjearCodigo(env, codigo, 2)).toBe(false);
    expect(await chatDelDueno(env)).toBe("1");
  });

  it("un código vencido no vincula", async () => {
    const antes = Date.now() - 20 * 60_000;
    const { codigo } = await crearCodigoDeVinculo(env, antes);
    expect(await canjearCodigo(env, codigo, 5)).toBe(false);
    expect(await chatDelDueno(env)).toBeNull();
  });

  it("el secret OWNER_TELEGRAM_CHAT_ID sigue mandando si existe", async () => {
    await vincular();
    expect(await chatDelDueno({ ...env, OWNER_TELEGRAM_CHAT_ID: "999" })).toBe("999");
  });
});

describe("quién llega a la consola", () => {
  it("el mensaje de una clienta NO lo consume la consola: sigue al agente", async () => {
    await vincular();
    expect(await atenderAlDueno(env, mensaje("hola, tienen talla M?", {}, 1234), OK)).toBe(false);
  });

  it("sin dueño vinculado, todo sigue al agente", async () => {
    expect(await atenderAlDueno(env, mensaje("/pendientes"), OK)).toBe(false);
  });

  it("en modo clienta, el dueño habla con el bot como cualquiera (y /dueno lo regresa)", async () => {
    await vincular();
    await atenderAlDueno(env, mensaje("/cliente"), OK);
    expect(await atenderAlDueno(env, mensaje("hola bot"), OK)).toBe(false);
    expect(await atenderAlDueno(env, mensaje("/dueno"), OK)).toBe(true);
    expect(await atenderAlDueno(env, mensaje("/pendientes"), OK)).toBe(true);
  });

  it("los botones de otra persona no hacen nada", async () => {
    await vincular();
    expect(await atenderAlDueno(env, boton("a:xxxx", 1, 4444), OK)).toBe(true);
    expect(enviados.find((e) => e.metodo === "answerCallbackQuery")?.cuerpo.text).toMatch(/solo para el dueño/);
  });
});

describe("sin la firma de Telegram, la consola no obedece", () => {
  it("un update falso 'del dueño' no ejecuta nada y no llega al agente", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "9@lid", "Eva");
    expect(await atenderAlDueno(env, mensaje("/pausar Eva"), { confiable: false })).toBe(true);
    expect(await convs.isPaused(conv.id)).toBe(false);
    // Se protege solo: registra el webhook con el secreto y pide repetir.
    expect(textos().at(-1)).toMatch(/activé la protección/);
    expect(enviados.some((e) => e.metodo === "setWebhook" && e.cuerpo.secret_token)).toBe(true);
  });

  it("un botón falso tampoco", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "8@lid", "Fer");
    await avisarAlDueno(env, { titulo: "t", cuerpo: "c", conversationId: conv.id });
    await atenderAlDueno(env, boton(datoDe("Pausar")), { confiable: false });
    expect(await convs.isPaused(conv.id)).toBe(false);
  });

  it("un botón del dueño sin firma protege la consola, y el segundo toque (ya firmado) lo hace", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "7@lid", "Gil");
    await avisarAlDueno(env, { titulo: "t", cuerpo: "c", conversationId: conv.id });
    const pausar = datoDe("Pausar");
    await atenderAlDueno(env, boton(pausar), { confiable: false });
    expect(await convs.isPaused(conv.id)).toBe(false);
    expect(enviados.filter((e) => e.metodo === "answerCallbackQuery").at(-1)?.cuerpo.text).toMatch(/Toca el botón otra vez/);
    // No manda al panel: el botón no se gastó.
    await atenderAlDueno(env, boton(pausar), OK);
    expect(await convs.isPaused(conv.id)).toBe(true);
  });

  it("ni el código de vínculo", async () => {
    const { codigo } = await crearCodigoDeVinculo(env);
    await atenderAlDueno(env, mensaje(`/start dueno_${codigo}`), { confiable: false });
    expect(await chatDelDueno(env)).toBeNull();
  });

  it("una clienta sin firma sigue al agente como siempre", async () => {
    await vincular();
    expect(await atenderAlDueno(env, mensaje("hola", {}, 1234), { confiable: false })).toBe(false);
  });

  it("el secreto sale del token del bot y se compara exacto", async () => {
    const { secretoDelWebhook, webhookConfiable } = await import("../../src/owner/telegram");
    const s1 = await secretoDelWebhook(env);
    expect(s1).toMatch(/^[0-9a-f]{48}$/);
    expect(await webhookConfiable(env, s1)).toBe(true);
    expect(await webhookConfiable(env, "otro")).toBe(false);
    expect(await webhookConfiable({ ...env, TELEGRAM_BOT_TOKEN: "otro-token" }, s1)).toBe(false);
  });

  it("asegurarWebhook registra el secreto y habilita los botones", async () => {
    const { asegurarWebhook, secretoDelWebhook } = await import("../../src/owner/telegram");
    expect(await asegurarWebhook(env)).toEqual({ ok: true });
    const set = enviados.find((e) => e.metodo === "setWebhook")!;
    expect(set.cuerpo).toMatchObject({
      url: "https://bot.ejemplo/webhooks/telegram",
      secret_token: await secretoDelWebhook(env),
      allowed_updates: ["message", "callback_query"],
    });
  });
});

describe("con el ID como secret basta: sin pasar por el panel", () => {
  const conSecret = () => ({ ...env, OWNER_TELEGRAM_CHAT_ID: String(DUENO) });

  it("el primer aviso protege la consola ANTES de salir, así su primer botón ya va firmado", async () => {
    const { secretoDelWebhook } = await import("../../src/owner/telegram");
    expect(await avisarAlDueno(conSecret(), { titulo: "🚨 Ticket", cuerpo: "Quiere pagar" })).toBe(true);
    const set = enviados.findIndex((e) => e.metodo === "setWebhook");
    const aviso = enviados.findIndex((e) => e.metodo === "sendMessage");
    expect(set).toBeGreaterThanOrEqual(0);
    expect(set).toBeLessThan(aviso);
    expect(enviados[set].cuerpo.secret_token).toBe(await secretoDelWebhook(env));
  });

  it("una sola vez por token: los avisos siguientes no vuelven a llamar a setWebhook", async () => {
    await avisarAlDueno(conSecret(), { titulo: "1", cuerpo: "a" });
    await avisarAlDueno(conSecret(), { titulo: "2", cuerpo: "b" });
    expect(enviados.filter((e) => e.metodo === "setWebhook")).toHaveLength(1);
    // Otro token es otro secreto: se vuelve a proteger.
    await avisarAlDueno({ ...conSecret(), TELEGRAM_BOT_TOKEN: "token-nuevo" }, { titulo: "3", cuerpo: "c" });
    expect(enviados.filter((e) => e.metodo === "setWebhook")).toHaveLength(2);
  });

  it("sin dueño no toca el webhook", async () => {
    const { protegerConsolaUnaVez } = await import("../../src/owner/dueno");
    await protegerConsolaUnaVez(env);
    expect(enviados).toHaveLength(0);
  });
});

describe("el aviso se puede responder: el texto le llega a la clienta", () => {
  it("responder sobre el aviso sale por el canal de la clienta, se anota y pausa el bot", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "245161514766536@lid", "Ana");

    expect(await avisarAlDueno(env, { titulo: "🚨 Ticket · pago", cuerpo: "Quiere pagar", conversationId: conv.id })).toBe(true);
    const aviso = enviados.find((e) => e.metodo === "sendMessage")!;
    expect(aviso.cuerpo.text).toContain("Ana · WhatsApp (QR)");
    const botones = aviso.cuerpo.reply_markup.inline_keyboard.flat().map((b: any) => b.text);
    expect(botones).toEqual(expect.arrayContaining(["▶️ Devolver al bot", "⏸ Pausar bot", "💬 Abrir en el panel"]));
    expect(botones).not.toContain("🛒 Registrar venta");

    await atenderAlDueno(env, mensaje("Hola Ana, ya le confirmo su pedido", { reply_to_message: { message_id: 100 } }), OK);

    expect(alPuente).toEqual([expect.objectContaining({ para: "245161514766536@lid", chunks: ["Hola Ana, ya le confirmo su pedido"] })]);
    const ultimo = (await new MessagesRepo(db).lastN(conv.id, 1))[0];
    expect([ultimo.role, ultimo.content]).toEqual(["owner", "Hola Ana, ya le confirmo su pedido"]);
    expect(await convs.isPaused(conv.id)).toBe(true);
    expect(textos().at(-1)).toMatch(/Enviado a Ana/);
  });

  it("el botón Devolver al bot quita la pausa y cierra el ticket", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "1@lid", "Bea");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    await avisarAlDueno(env, { titulo: "t", cuerpo: "c", conversationId: conv.id });

    await atenderAlDueno(env, boton(datoDe("Devolver")), OK);
    expect(await convs.isPaused(conv.id)).toBe(false);
    expect(textos().at(-1)).toMatch(/Devuelta al bot/);
  });

  it("un botón tocado dos veces se ejecuta una sola vez", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "2@lid", "Cata");
    await avisarAlDueno(env, { titulo: "t", cuerpo: "c", conversationId: conv.id });
    const data = datoDe("Pausar");
    await atenderAlDueno(env, boton(data), OK);
    await atenderAlDueno(env, boton(data), OK);
    expect(enviados.filter((e) => e.metodo === "answerCallbackQuery").at(-1)?.cuerpo.text).toMatch(/ya se hizo/);
  });
});

describe("/pendientes", () => {
  it("lista las conversaciones que atiende una persona, con su botón para devolver", async () => {
    await vincular();
    const convs = new ConversationsRepo(db);
    const conv = await convs.getOrCreate("whatsapp-qr", "3@lid", "Dora");
    await convs.setPausedUntil(conv.id, Date.now() + 60_000);
    await atenderAlDueno(env, mensaje("/pendientes"), OK);
    expect(textos().at(-1)).toContain("Dora");
    expect(ultimoTeclado().map((b) => b.text)).toContain("▶️ Devolver: Dora");
  });
});

describe("/miid", () => {
  it("el dueño vinculado también lo puede pedir en la consola", async () => {
    await vincular();
    await atenderAlDueno(env, mensaje("/miid"), OK);
    expect(textos().at(-1)).toContain(String(DUENO));
  });
});

describe("piezas", () => {
  it("partirComando quita el @bot y las tildes", () => {
    expect(partirComando("/Pendientes@PanaClawBot")).toEqual(["pendientes", ""]);
    expect(partirComando("hola")).toBeNull();
  });
});

describe("la consola recuerda, oye y ve", () => {
  const memoria = async () =>
    ((await db.all<{ rol: string; contenido: string }>("SELECT rol, contenido FROM owner_chat ORDER BY id")) ?? []).map(
      (f) => `${f.rol}: ${f.contenido}`,
    );

  it("una nota de voz se transcribe, se le muestra lo que se entendió y va al asistente", async () => {
    await vincular();
    llm.activo = true;
    llm.respuesta = "Hoy le escribieron dos clientas.";
    env.AI = { run: vi.fn(async () => ({ text: "¿quién me escribió hoy?" })) };
    const voz = mensaje("", { voice: { file_id: "v1", duration: 4 } });
    delete (voz.message as any).text;
    expect(await atenderAlDueno(env, voz, OK)).toBe(true);

    expect(textos()).toEqual(["🎤 «¿quién me escribió hoy?»", "Hoy le escribieron dos clientas."]);
    expect(enviados.some((e) => e.metodo === "sendChatAction")).toBe(true);
    const ultimo = llm.llamadas[0].messages.at(-1);
    expect(ultimo).toEqual({ role: "user", content: "(nota de voz) ¿quién me escribió hoy?" });
    // Sabe con quién habla y para qué es el canal.
    expect(llm.llamadas[0].system).toMatch(/jefe de la empresa/);
    expect(llm.llamadas[0].system).toMatch(/seguimiento/);
    expect(Object.keys(llm.llamadas[0].tools)).toEqual(expect.arrayContaining(["verClientesRecientes", "verInteresados"]));
  });

  it("recuerda lo que se habló: el segundo mensaje lleva el primero y su respuesta", async () => {
    await vincular();
    llm.activo = true;
    llm.respuesta = "De la NAT-M hay 7 cajas.";
    await atenderAlDueno(env, mensaje("¿cuánto hay de la M?"), OK);
    llm.respuesta = "De la L no hay.";
    await atenderAlDueno(env, mensaje("¿y de la L?"), OK);

    expect(llm.llamadas[1].messages).toEqual([
      { role: "user", content: "¿cuánto hay de la M?" },
      { role: "assistant", content: "De la NAT-M hay 7 cajas." },
      { role: "user", content: "¿y de la L?" },
    ]);
  });

  it("los comandos y lo que hicieron también son contexto", async () => {
    await vincular();
    const conv = await new ConversationsRepo(db).getOrCreate("whatsapp-qr", "5@lid", "Leo");
    await atenderAlDueno(env, mensaje("/pausar Leo"), OK);
    await avisarAlDueno(env, { titulo: "t", cuerpo: "c", conversationId: conv.id });
    await atenderAlDueno(env, boton(datoDe("Devolver")), OK);
    const m = await memoria();
    expect(m[0]).toBe("dueno: /pausar Leo");
    expect(m[1]).toMatch(/^consola: [\s\S]*Leo/);
    expect(m.at(-1)).toMatch(/^consola: .*Devuelta al bot/);
  });

  it("/nuevo borra la memoria", async () => {
    await vincular();
    await atenderAlDueno(env, mensaje("/pendientes"), OK);
    await atenderAlDueno(env, mensaje("/nuevo"), OK);
    expect(await memoria()).toEqual(["consola: 🧹 Listo, empezamos de cero. Los avisos y los comandos siguen igual."]);
  });

  it("una foto con leyenda va al asistente como imagen", async () => {
    await vincular();
    llm.activo = true;
    llm.respuesta = "Veo la factura: 10 cajas de NAT-M.";
    await atenderAlDueno(env, mensaje("", { caption: "llegó esto del proveedor", photo: [{ file_id: "p1" }, { file_id: "p2" }] }), OK);
    const contenido = llm.llamadas[0].messages.at(-1).content;
    expect(contenido[0]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
    expect(contenido[1]).toEqual({ type: "text", text: "llegó esto del proveedor" });
    expect(enviados.find((e) => e.metodo === "getFile")?.cuerpo).toBeDefined();
  });

  it("una nota de voz sobre un aviso es una instrucción sobre ESA conversación, y nada sale sin botón", async () => {
    await vincular();
    const conv = await new ConversationsRepo(db).getOrCreate("whatsapp-qr", "245161514766536@lid", "Ana");
    await avisarAlDueno(env, { titulo: "🚨 Ticket", cuerpo: "Quiere pagar", conversationId: conv.id });
    llm.activo = true;
    llm.respuesta = "Le propongo el mensaje.";
    env.AI = { run: vi.fn(async () => ({ text: "dile que sí tenemos talla M" })) };
    const voz = mensaje("", { voice: { file_id: "v2", duration: 3 }, reply_to_message: { message_id: 100 } });
    delete (voz.message as any).text;
    await atenderAlDueno(env, voz, OK);

    expect(alPuente).toEqual([]);
    expect(llm.llamadas[0].messages.at(-1).content).toMatch(/aviso de la conversación de Ana/);
  });

  it("un comprobante que el bot escala le llega al dueño como foto, antes del aviso", async () => {
    await vincular();
    const conv = await new ConversationsRepo(db).getOrCreate("whatsapp-qr", "9@lid", "Eva");
    const { guardarMedia, urlDeMedia } = await import("../../src/media/almacen");
    const url = await urlDeMedia(env, await guardarMedia(env, new Uint8Array([255, 216, 255]), "image/jpeg"));
    await avisarAlDueno(env, { titulo: "🚨 Ticket · archivo", cuerpo: "Un comprobante", conversationId: conv.id, foto: url });
    const foto = enviados.findIndex((e) => e.metodo === "sendPhoto");
    const aviso = enviados.findIndex((e) => e.metodo === "sendMessage");
    expect(foto).toBeGreaterThanOrEqual(0);
    expect(foto).toBeLessThan(aviso);
  });

  // 24-sep-2026: en PanaClaw ninguna imagen del cliente le llegaba al dueño.
  // Solo Baby Caleb las mandaba, y solo con escalar_media encendido.
  it("un aviso sin foto explícita lleva la última imagen que mandó el cliente, y una sola vez", async () => {
    await vincular();
    const conv = await new ConversationsRepo(db).getOrCreate("whatsapp-qr", "7@lid", "Leo");
    const { guardarMedia, urlDeMedia } = await import("../../src/media/almacen");
    const url = await urlDeMedia(env, await guardarMedia(env, new Uint8Array([255, 216, 255]), "image/jpeg"));
    await new MessagesRepo(db).append(conv.id, "user", `aquí va la factura\n[IMAGE_URL: ${url}]`);

    await avisarAlDueno(env, { titulo: "🚨 Ticket · pago", cuerpo: "Quiere que revisen su pago", conversationId: conv.id });
    expect(enviados.filter((e) => e.metodo === "sendPhoto")).toHaveLength(1);

    // El aviso siguiente de la misma conversación no la repite.
    await avisarAlDueno(env, { titulo: "🛍 Nuevo", cuerpo: "Dejó sus datos", conversationId: conv.id });
    expect(enviados.filter((e) => e.metodo === "sendPhoto")).toHaveLength(1);
  });

  it("los avisos sin conversación (salud del bot, prueba del panel) no llevan foto", async () => {
    await vincular();
    await avisarAlDueno(env, { titulo: "⚠️ Salud", cuerpo: "algo", conBotones: false });
    expect(enviados.filter((e) => e.metodo === "sendPhoto")).toHaveLength(0);
  });
});

// 24-sep-2026 (PanaClaw): "respóndele a Brian de 62272025" encontró por el
// número una conversación VIEJA de Brian por el WhatsApp oficial; el mensaje
// "salió" por ahí (fuera de la ventana de 24 h, nadie lo recibió) en vez de por
// el WhatsApp QR del aviso que el dueño estaba mirando. Y el asistente dijo
// después "✅ Mensaje enviado" sin haber enviado nada.
describe("a quién le escribe la consola", () => {
  it("prefiere la conversación del aviso reciente sobre otra del mismo cliente por otro canal", async () => {
    await vincular();
    const repo = new ConversationsRepo(db);
    const viejaOficial = await repo.getOrCreate("whatsapp", "50762272025", "Bukoflow");
    const delAviso = await repo.getOrCreate("whatsapp-qr", "59034493255880@lid", "Bukoflow");
    const { anotarAviso } = await import("../../src/owner/acciones");
    await anotarAviso(env, String(DUENO), 321, delAviso.id, null);
    const { unaConversacion } = await import("../../src/owner/cerebro");
    const r = await unaConversacion({ env, chatId: String(DUENO), actor: "t" } as any, "62272025");
    expect((r as any).conv?.id).toBe(delAviso.id);
    expect((r as any).conv?.id).not.toBe(viejaOficial.id);
  });

  it("no finge un envío por el WhatsApp oficial pasadas 24 h: lo dice", async () => {
    const repo = new ConversationsRepo(db);
    const conv = await repo.getOrCreate("whatsapp", "50760000000", "Viejo");
    await db.run("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('v1', ?, 'user', 'hola', ?)", [
      conv.id,
      Date.now() - 3 * 24 * 3_600_000,
    ]);
    const { responderACliente } = await import("../../src/owner/acciones");
    const r = await responderACliente(env, conv.id, "hola");
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/24 h/);
  });

  it("el asistente tiene prohibido dar por hecho un envío que no hizo", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/owner/cerebro.ts", "utf8");
    expect(src).toMatch(/NUNCA digas que un mensaje se envió/);
  });
});
