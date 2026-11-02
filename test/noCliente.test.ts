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
} from "../src/noCliente";

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
