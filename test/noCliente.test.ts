/**
 * Quién escribe sin venir a comprar (auditoría de Meta Ads, 1-nov-2026). Los
 * mensajes son los reales de la primera semana de anuncios, sin los datos de
 * las personas.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "./helpers/miniflareSetup";
import { Db } from "../src/db/client";
import { ConversationsRepo } from "../src/db/conversations";
import { MessagesRepo } from "../src/db/messages";
import {
  motivoNoCliente,
  escribioAlgoPropio,
  loQueEscribio,
  esAperturaDeAnuncio,
  revisarNoCliente,
  decidirNoCliente,
  noClienteDe,
  notaParaElBot,
  esSoloNumero,
  hayIntencionComercial,
  yaCerroConNoCliente,
  esNumeroSinPregunta,
  marcarNoClientePorElBot,
  detalleNoCliente,
} from "../src/noCliente";
import { marcarNoClienteTool } from "../src/tools/marcarNoCliente";

const ANUNCIO = "[ANUNCIO: llegó desde un anuncio de Meta: «Tu página web en 72 horas · $295» · «Si vas a abrir tu negocio»]";
const APERTURA = `Hola, vi el anuncio de la página web de $295 en 72 horas. Quiero información.\n${ANUNCIO}`;

describe("lo que escribió la persona", () => {
  it("sin la marca del anuncio ni el mensaje que el anuncio escribe solo", () => {
    expect(loQueEscribio(APERTURA)).toBe("hola,");
    expect(esAperturaDeAnuncio(APERTURA)).toBe(true);
    expect(esAperturaDeAnuncio("Quiero una página para mi negocio")).toBe(false);
  });

  it("el mensaje automático, un saludo o una nota de voz vacía no son contestar", () => {
    expect(escribioAlgoPropio([APERTURA])).toBe(false);
    expect(escribioAlgoPropio([APERTURA, "Buenas noches, que Dios le bendiga"])).toBe(false);
    expect(escribioAlgoPropio([APERTURA, "(audio sin transcripción)\n[ADJUNTO: abc]"])).toBe(false);
  });

  it("una pregunta frecuente del anuncio, una respuesta o una foto sí", () => {
    expect(escribioAlgoPropio([`¿Qué NO incluye el plan?\n${ANUNCIO}`])).toBe(true);
    expect(escribioAlgoPropio([APERTURA, "Ok…"])).toBe(true);
    expect(escribioAlgoPropio([APERTURA, "(imagen sin caption)\n[IMAGE_URL: https://x/y]"])).toBe(true);
    // Si cambió el texto del anuncio, escribió algo suyo.
    expect(escribioAlgoPropio(["Hola, vi el anuncio de la página web de $295 en 72 horas. Estoy dispuesto, quiero información."])).toBe(true);
  });
});

describe("quién no viene a comprar", () => {
  it("un préstamo", () => {
    expect(motivoNoCliente([APERTURA, "Quiero prestamo de 2000 dolares"])).toBe("prestamo");
    expect(motivoNoCliente([APERTURA, "Necesito un préstame de $2000 cuánto sería el interés"])).toBe("prestamo");
  });

  it("empleo", () => {
    expect(motivoNoCliente([`Buenas\n${ANUNCIO}`, "Éstóy busca empleo\n[IMAGE_URL: https://x/y]"])).toBe("empleo");
    expect(motivoNoCliente([APERTURA, "¿Están contratando? Les envío mi hoja de vida"])).toBe("empleo");
  });

  it("por error o que lo borren", () => {
    expect(motivoNoCliente([APERTURA, "Toqué el anuncio sin querer"])).toBe("por-error");
    expect(motivoNoCliente([APERTURA, "No fui yo"])).toBe("por-error");
    expect(motivoNoCliente([APERTURA, "Bórrenme de su lista"])).toBe("por-error");
  });

  it("solo saludos, dos veces seguidas (tocar el anuncio no cuenta como una)", () => {
    expect(motivoNoCliente([APERTURA, "Hola"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "Hola", "Buenas tardes, bendiciones"])).toBe("sin-contenido");
    expect(motivoNoCliente(["Hola\n" + APERTURA, "Buen día, buen día."])).toBeNull();
  });

  it("si después escribe algo de verdad, deja de ser «solo saludó»", () => {
    expect(motivoNoCliente([APERTURA, "Hola", "Buenas", "Quiero la página para mi restaurante"])).toBeNull();
  });

  it("conservador: un cliente que pregunta por pagos o pide un portafolio es cliente", () => {
    expect(motivoNoCliente([APERTURA, "¿Puedo pagar en quincenas?"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "Quiero una página tipo portafolio para mis fotos"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "Me interesa, ¿cómo es el pago?"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "Busco que me hagan la página de mi negocio"])).toBeNull();
    // Otro alfabeto no es un saludo de la lista: no se marca.
    expect(motivoNoCliente([APERTURA, "До маньяна", "Hola"])).toBeNull();
  });

  it("la nota para el bot le dice que no lo anote y que cierre con amabilidad", () => {
    const nota = notaParaElBot("prestamo");
    expect(nota).toMatch(/<no_viene_a_comprar>/);
    expect(nota).toMatch(/No la anotes con captureLead/);
    expect(nota).toMatch(/no presta dinero/);
    expect(notaParaElBot("sin-contenido")).toMatch(/Nada de planes, precios ni enlaces/);
  });
});

describe("la marca en la conversación", () => {
  let db: Db;
  const CONV = "whatsapp:50760000000";

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    db = new Db((await mf.getD1Database("DB")) as any);
    await new ConversationsRepo(db).getOrCreate("whatsapp", "50760000000", "Cliente");
    await db.run("UPDATE conversations SET metadata = ? WHERE id = ?", [JSON.stringify({ anuncio: { ctwa_clid: "C1", at: 1 } }), CONV]);
  });

  it("se guarda sin pisar lo demás de metadata, y un préstamo no se borra solo", async () => {
    const msgs = new MessagesRepo(db);
    await msgs.append(CONV, "user", APERTURA);
    await msgs.append(CONV, "user", "Quiero un préstamo de 500");
    expect(await revisarNoCliente(db, CONV)).toBe("prestamo");
    const fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [CONV]);
    expect(JSON.parse(fila!.metadata)).toMatchObject({ anuncio: { ctwa_clid: "C1" }, no_cliente: { motivo: "prestamo" } });
    expect(await noClienteDe(db, CONV)).toBe("prestamo");
  });

  it("«solo saludó» se quita cuando escribe algo", async () => {
    const msgs = new MessagesRepo(db);
    await msgs.append(CONV, "user", APERTURA);
    await msgs.append(CONV, "user", "Hola");
    await msgs.append(CONV, "user", "Buenas");
    expect(await revisarNoCliente(db, CONV)).toBe("sin-contenido");
    await msgs.append(CONV, "user", "Es para mi tienda de ropa");
    expect(await revisarNoCliente(db, CONV)).toBeNull();
    expect(await noClienteDe(db, CONV)).toBeNull();
  });

  it("lo que decide el dueño manda: el detector ya no toca la conversación", async () => {
    const msgs = new MessagesRepo(db);
    await msgs.append(CONV, "user", "Quiero un préstamo para mi negocio y también la página");
    expect(await revisarNoCliente(db, CONV)).toBe("prestamo");
    await decidirNoCliente(db, CONV, true);
    expect(await noClienteDe(db, CONV)).toBeNull();
    expect(await revisarNoCliente(db, CONV)).toBeNull();

    await decidirNoCliente(db, CONV, false);
    expect(await noClienteDe(db, CONV)).toBe("a-mano");
  });
});

describe("quien pide ayuda, un padrino o un regalo (conversación real del 8-nov-2026)", () => {
  const VOZ =
    "(nota de voz) Le pedido a Dios que haya una mano amiga que por obra de él me dé esa, como un apadrinamiento, como padrino, para ver cómo uno se vive en otras condiciones.";

  it("se marca a la segunda cosa que dice, no a los veinte mensajes", () => {
    expect(motivoNoCliente([APERTURA, VOZ])).toBe("pide-ayuda");
    expect(motivoNoCliente([APERTURA, "Busco una mano amiga que me ayude con dinero"])).toBe("pide-ayuda");
    expect(motivoNoCliente([APERTURA, "¿Me regalan una página? Es que no tengo plata"])).toBe("pide-ayuda");
  });

  it("conservador: nombrar a un padrino o pedir ayuda con la página NO es pedir un regalo", () => {
    expect(motivoNoCliente([APERTURA, "Mi padrino me recomendó ustedes, quiero una página"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "Necesito que me ayuden con una página para mi taller"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "¿Dan facilidades de pago?"])).toBeNull();
  });
});

describe("números sueltos (4 a 6 cifras)", () => {
  it("un número así no es escribir algo propio; una cifra corta o un teléfono sí", () => {
    expect(esSoloNumero("9927")).toBe(true);
    expect(esSoloNumero("8 796")).toBe(true);
    expect(esSoloNumero("295")).toBe(false);
    expect(esSoloNumero("66261919")).toBe(false);
    expect(esSoloNumero("quiero 9927")).toBe(false);
    expect(escribioAlgoPropio([APERTURA, "9927"])).toBe(false);
    expect(escribioAlgoPropio([APERTURA, "295"])).toBe(true);
    expect(escribioAlgoPropio([APERTURA, "66261919"])).toBe(true);
  });

  it("dos números sueltos y nada más: «solo manda números»; uno solo, todavía no", () => {
    expect(motivoNoCliente([APERTURA, "9927"])).toBeNull();
    expect(motivoNoCliente([APERTURA, "9927", "8796"])).toBe("solo-numeros");
    expect(motivoNoCliente([APERTURA, "Hola", "8796"])).toBe("sin-contenido");
    expect(motivoNoCliente([APERTURA, "9927", "8796", "Quiero una página"])).toBeNull();
  });
});

describe("quien habla de otra cosa durante seis mensajes", () => {
  const CHARLA = [
    "El café de altura es lo mejor que hay aquí",
    "Aquí en Panamá hay que tener mucho cuidado",
    "El ganado también está dando mucha utilidad",
    "Me gusta andar vigilando a los peones",
    "Dios le da fuerza a uno para seguir",
    "La finca de treinta hectáreas es un billete grande",
  ];

  it("seis mensajes sin una sola palabra de lo que vendemos", () => {
    expect(motivoNoCliente([APERTURA, ...CHARLA])).toBe("fuera-de-tema");
    expect(motivoNoCliente([APERTURA, ...CHARLA.slice(0, 5)])).toBeNull();
  });

  it("con una sola pregunta por lo que vendemos, ya no", () => {
    expect(motivoNoCliente([APERTURA, ...CHARLA.slice(0, 5), "¿Cuánto cuesta la página?"])).toBeNull();
    expect(hayIntencionComercial("¿y el precio del plan?")).toBe(true);
    expect(hayIntencionComercial("el café está muy caro este año")).toBe(false);
  });
});

describe("el bot se despide una vez y después calla", () => {
  let db: Db;
  let d1: any;
  const CONV = "whatsapp:50760000001";

  beforeEach(async () => {
    const mf = await createTestMiniflare();
    d1 = await mf.getD1Database("DB");
    db = new Db(d1 as any);
    await new ConversationsRepo(db).getOrCreate("whatsapp", "50760000001", "Cliente");
  });

  it("sin la marca, no hay silencio; con la marca y sin despedida todavía, tampoco; con despedida, sí", async () => {
    const msgs = new MessagesRepo(db);
    expect(await yaCerroConNoCliente(db, CONV)).toBe(false);
    await msgs.append(CONV, "user", APERTURA);
    await msgs.append(CONV, "user", "Quiero un préstamo de 500", { createdAt: 1_000 });
    expect(await revisarNoCliente(db, CONV, 2_000)).toBe("prestamo");
    expect(await yaCerroConNoCliente(db, CONV)).toBe(false);
    await msgs.append(CONV, "assistant", "No prestamos dinero, que le vaya bien.", { createdAt: 3_000 });
    expect(await yaCerroConNoCliente(db, CONV)).toBe(true);
  });

  it("un número suelto sin pregunta del bot no se contesta; si el bot pidió una cifra, sí", async () => {
    const msgs = new MessagesRepo(db);
    await msgs.append(CONV, "assistant", "¿Le interesa una página nueva?", { createdAt: 1_000 });
    expect(await esNumeroSinPregunta(db, CONV, "8796")).toBe(true);
    expect(await esNumeroSinPregunta(db, CONV, "Sí, me interesa")).toBe(false);
    await msgs.append(CONV, "assistant", "¿Cuál es su presupuesto?", { createdAt: 2_000 });
    expect(await esNumeroSinPregunta(db, CONV, "1500")).toBe(false);
  });

  it("la herramienta del bot marca «otra cosa» con el motivo, y el dueño manda sobre ella", async () => {
    const env = { DB: d1 } as any;
    const marcar = marcarNoClienteTool(env, () => CONV);
    const r: any = await (marcar as any).execute({ motivo: "pide un padrino" }, {} as any);
    expect(r.ok).toBe(true);
    expect(await noClienteDe(db, CONV)).toBe("otra-cosa");
    const fila = await db.first<{ metadata: string }>("SELECT metadata FROM conversations WHERE id = ?", [CONV]);
    expect(detalleNoCliente(fila!.metadata)).toBe("pide un padrino");

    // El dueño dice «sí es cliente»: el bot ya no puede volver a marcarla.
    await decidirNoCliente(db, CONV, true);
    expect(await marcarNoClientePorElBot(db, CONV, "otra vez")).toBe(false);
    expect(await noClienteDe(db, CONV)).toBeNull();
  });
});
