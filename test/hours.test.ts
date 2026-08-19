/**
 * Horario laboral: lectura de lo que escribe una persona en el panel y la
 * pregunta que de verdad importa —¿se puede escribir a un cliente AHORA?—
 * resuelta en la zona horaria del negocio.
 *
 * Los instantes son fijos y en UTC, y cada caso dice al lado qué hora es en
 * Panamá. Es la única forma de que la suite dé lo mismo corriendo a las 3 de la
 * tarde que en el CI de madrugada, que es justo el escenario que este módulo
 * existe para gobernar.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_BUSINESS_HOURS,
  formatBusinessHours,
  isWithinBusinessHours,
  localTime,
  parseBusinessHours,
} from "../src/hours";

const PA = "America/Panama"; // GMT-5 todo el año, sin horario de verano

describe("parseBusinessHours", () => {
  it("lee el formato del panel", () => {
    expect(parseBusinessHours("L-V 9:00-18:00")).toEqual({
      days: [1, 2, 3, 4, 5],
      startMinute: 540,
      endMinute: 1080,
    });
  });

  it("admite horas sin minutos, días sueltos y rangos que cruzan el domingo", () => {
    expect(parseBusinessHours("L-V 9-18")).toEqual(DEFAULT_BUSINESS_HOURS);
    expect(parseBusinessHours("S,D 10:00-14:00")?.days).toEqual([0, 6]);
    expect(parseBusinessHours("V-L 8:00-12:00")?.days).toEqual([0, 1, 5, 6]);
  });

  it("sin bloque de días son todos los días", () => {
    expect(parseBusinessHours("8:00-20:00")?.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  /*
   * Ante la duda, NADA. Quien llama se queda con el horario por defecto, que es
   * conservador. Devolver "todo el día" ante una errata convertiría un error de
   * tecleo en permiso para escribirle a un cliente de madrugada.
   */
  it.each([
    ["vacío", ""],
    ["solo espacios", "   "],
    ["nulo", null],
    ["texto libre", "de lunes a viernes por la mañana"],
    ["letra de día inexistente", "Z-V 9:00-18:00"],
    ["hora imposible", "L-V 9:00-99:00"],
    ["fin antes que inicio", "L-V 18:00-9:00"],
    ["fin igual que inicio", "L-V 9:00-9:00"],
  ])("devuelve null con %s", (_caso, spec) => {
    expect(parseBusinessHours(spec as string | null)).toBeNull();
  });

  it("da la vuelta: lo leído se vuelve a imprimir igual", () => {
    const parsed = parseBusinessHours("L-V 9-18")!;
    expect(formatBusinessHours(parsed)).toBe("L,M,X,J,V 09:00-18:00");
    expect(parseBusinessHours(formatBusinessHours(parsed))).toEqual(parsed);
    expect(formatBusinessHours(parseBusinessHours("8:00-20:00")!)).toBe(
      "Todos los días 08:00-20:00",
    );
  });
});

describe("localTime", () => {
  it("resuelve la hora en la zona del negocio, no en UTC", () => {
    // 2026-08-19T19:00Z = miércoles 14:00 en Panamá.
    const t = localTime(new Date(Date.UTC(2026, 7, 19, 19, 0)), PA);
    expect(t.clock).toBe("14:00");
    expect(t.weekday).toBe(3);
  });

  it("cruza el día hacia atrás cuando toca", () => {
    // 2026-08-20T02:30Z sigue siendo miércoles 21:30 en Panamá.
    const t = localTime(new Date(Date.UTC(2026, 7, 20, 2, 30)), PA);
    expect(t.clock).toBe("21:30");
    expect(t.weekday).toBe(3);
  });

  it("aplica el horario de verano de la zona que lo tenga", () => {
    const enero = localTime(new Date(Date.UTC(2026, 0, 15, 17, 0)), "America/New_York");
    const julio = localTime(new Date(Date.UTC(2026, 6, 15, 17, 0)), "America/New_York");
    expect(enero.clock).toBe("12:00"); // EST, GMT-5
    expect(julio.clock).toBe("13:00"); // EDT, GMT-4
  });

  it("no revienta con una zona horaria mal escrita", () => {
    const t = localTime(new Date(Date.UTC(2026, 7, 19, 19, 0)), "America/Panamá");
    expect(t.clock).toBe("14:00"); // cae al default, que es la misma zona
  });
});

describe("isWithinBusinessHours", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0) =>
    new Date(Date.UTC(y, m, d, h, min));

  it("de día laborable sí, de madrugada y de noche no", () => {
    expect(isWithinBusinessHours(at(2026, 7, 19, 19), PA)).toBe(true); // mié 14:00
    expect(isWithinBusinessHours(at(2026, 7, 19, 8), PA)).toBe(false); // mié 03:00
    expect(isWithinBusinessHours(at(2026, 7, 20, 3), PA)).toBe(false); // mié 22:00
  });

  it("el fin de semana está cerrado con el horario por defecto", () => {
    expect(isWithinBusinessHours(at(2026, 7, 22, 17), PA)).toBe(false); // sáb 12:00
    expect(isWithinBusinessHours(at(2026, 7, 23, 17), PA)).toBe(false); // dom 12:00
  });

  /*
   * Los bordes se fijan aquí porque son la diferencia entre un mensaje a las
   * 8:59 y uno a las 18:00 clavadas: abre incluido, cierra excluido.
   */
  it("abre incluido y cierra excluido", () => {
    expect(isWithinBusinessHours(at(2026, 7, 19, 13, 59), PA)).toBe(false); // 08:59
    expect(isWithinBusinessHours(at(2026, 7, 19, 14, 0), PA)).toBe(true); // 09:00
    expect(isWithinBusinessHours(at(2026, 7, 19, 22, 59), PA)).toBe(true); // 17:59
    expect(isWithinBusinessHours(at(2026, 7, 19, 23, 0), PA)).toBe(false); // 18:00
  });

  it("respeta un horario a medida", () => {
    const sabados = parseBusinessHours("L-S 10:00-20:00")!;
    expect(isWithinBusinessHours(at(2026, 7, 22, 17), PA, sabados)).toBe(true); // sáb 12:00
    expect(isWithinBusinessHours(at(2026, 7, 23, 17), PA, sabados)).toBe(false); // dom 12:00
  });

  it("la misma hora UTC cae dentro o fuera según la zona del negocio", () => {
    // 2026-08-19T14:00Z: 09:00 en Panamá (abierto) y 16:00 en Madrid (abierto),
    // pero 23:00 en Tokio (cerrado). Es el bug que evita todo este módulo.
    const instante = at(2026, 7, 19, 14);
    expect(isWithinBusinessHours(instante, PA)).toBe(true);
    expect(isWithinBusinessHours(instante, "Europe/Madrid")).toBe(true);
    expect(isWithinBusinessHours(instante, "Asia/Tokyo")).toBe(false);
  });
});
