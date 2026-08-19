/**
 * Horario laboral del negocio, en su propia zona horaria.
 *
 * Lo usan dos cosas, y por eso vive aquí y no dentro de ninguna de las dos:
 *
 *  • El seguimiento (src/followup/run.ts): un mensaje proactivo a las 3 de la
 *    madrugada no es atención al cliente, es una molestia — y en WhatsApp es
 *    de las cosas que hacen que a un negocio lo bloqueen. El bot CONTESTA a
 *    cualquier hora; lo que se calla de noche es lo que nadie le pidió.
 *  • El agente (src/agent.ts): saber si en este momento hay alguien del equipo
 *    disponible cambia lo que el bot promete. Dentro de horario puede decir
 *    "te paso con una persona"; fuera, lo honesto es decir cuándo le
 *    responden.
 *
 * La hora SIEMPRE se resuelve en la zona del negocio (`BOT_TIMEZONE`), nunca en
 * UTC ni en la del servidor: el Worker corre donde Cloudflare quiera, y "las
 * 9 de la mañana" solo significa algo en el sitio donde está el negocio.
 */

/** 0 = domingo … 6 = sábado, igual que `Date#getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BusinessHours {
  /** Días laborables. Un día que no está aquí es día sin seguimiento. */
  days: Weekday[];
  /** Minutos desde medianoche. 9:00 → 540. */
  startMinute: number;
  endMinute: number;
}

/**
 * Lo que aplica si nadie configura nada: lunes a viernes, de 9 a 6.
 *
 * Es el horario que publica el sitio de PanaClaw y, de paso, el más común en la
 * región. Un default conservador importa aquí más que en otros sitios: si la
 * configuración viene rota, el error debe ser "no mandé un seguimiento que
 * podía haber mandado", no "desperté a un cliente a medianoche".
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 18 * 60,
};

/** Zona horaria por defecto si la instancia no declara `BOT_TIMEZONE`. */
export const DEFAULT_TIMEZONE = "America/Panama";

/** Orden de la semana como se escribe en español, para leer rangos "L-V". */
const DAY_LETTERS: { letter: string; day: Weekday }[] = [
  { letter: "L", day: 1 },
  { letter: "M", day: 2 },
  { letter: "X", day: 3 },
  { letter: "J", day: 4 },
  { letter: "V", day: 5 },
  { letter: "S", day: 6 },
  { letter: "D", day: 0 },
];

const WEEKDAY_FROM_SHORT: Record<string, Weekday> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function parseDays(spec: string): Weekday[] | null {
  const days = new Set<Weekday>();
  for (const token of spec.split(/[,;]/).map((t) => t.trim()).filter(Boolean)) {
    const range = token.match(/^([LMXJVSD])\s*[-–]\s*([LMXJVSD])$/i);
    if (range) {
      const from = DAY_LETTERS.findIndex((d) => d.letter === range[1].toUpperCase());
      const to = DAY_LETTERS.findIndex((d) => d.letter === range[2].toUpperCase());
      if (from === -1 || to === -1) return null;
      // Se recorre en círculo para admitir rangos que cruzan el domingo (V-L).
      for (let i = from; ; i = (i + 1) % DAY_LETTERS.length) {
        days.add(DAY_LETTERS[i].day);
        if (i === to) break;
      }
      continue;
    }
    const single = DAY_LETTERS.find((d) => d.letter === token.toUpperCase());
    if (!single) return null;
    days.add(single.day);
  }
  return days.size > 0 ? [...days].sort() : null;
}

function parseMinute(spec: string): number | null {
  const m = spec.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 24 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Lee un horario escrito por una persona en el panel.
 *
 * Formato: `L-V 9:00-18:00`. El bloque de días es opcional (sin él, todos los
 * días) y la hora admite `9` igual que `9:00`, porque es como se escribe cuando
 * uno tiene prisa.
 *
 * Devuelve `null` ante cualquier cosa que no entienda —incluida la cadena
 * vacía— y quien llama decide el default. Nunca "interpreta" a medias: un
 * horario mal leído manda mensajes a la hora equivocada, así que ante la duda
 * no hay horario.
 */
export function parseBusinessHours(spec: string | null | undefined): BusinessHours | null {
  const raw = spec?.trim();
  if (!raw) return null;

  const timeMatch = raw.match(/(\d{1,2}(?::\d{2})?)\s*[-–a]\s*(\d{1,2}(?::\d{2})?)\s*$/i);
  if (!timeMatch) return null;
  const startMinute = parseMinute(timeMatch[1]);
  const endMinute = parseMinute(timeMatch[2]);
  if (startMinute === null || endMinute === null) return null;
  // Un horario que termina antes de empezar no es un turno de noche: es un
  // error de tecleo. No se adivina.
  if (endMinute <= startMinute) return null;

  const daySpec = raw.slice(0, raw.length - timeMatch[0].length).trim();
  const days = daySpec ? parseDays(daySpec) : [0, 1, 2, 3, 4, 5, 6];
  if (!days) return null;

  return { days: days as Weekday[], startMinute, endMinute };
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function formatMinute(minute: number): string {
  return `${two(Math.floor(minute / 60))}:${two(minute % 60)}`;
}

/** Cómo se le enseña el horario a una persona (panel, prompt, logs). */
export function formatBusinessHours(hours: BusinessHours): string {
  const letters = DAY_LETTERS.filter((d) => hours.days.includes(d.day)).map((d) => d.letter);
  const dias = letters.length === 7 ? "Todos los días" : letters.join(",");
  return `${dias} ${formatMinute(hours.startMinute)}-${formatMinute(hours.endMinute)}`;
}

export interface LocalTime {
  weekday: Weekday;
  minuteOfDay: number;
  /** "14:35", ya en la zona del negocio. */
  clock: string;
}

/**
 * Qué hora es AHORA donde está el negocio.
 *
 * `Intl` hace la conversión, incluido el horario de verano de las zonas que lo
 * tienen. Si la zona no existe (una errata en la variable de entorno), se cae a
 * la de por defecto en vez de reventar: un seguimiento no vale una excepción no
 * capturada dentro del cron.
 */
export function localTime(at: Date, timezone: string = DEFAULT_TIMEZONE): LocalTime {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timezone);
  } catch {
    console.warn(`[hours] zona horaria desconocida: ${timezone}. Se usa ${DEFAULT_TIMEZONE}.`);
    parts = format(DEFAULT_TIMEZONE);
  }

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_FROM_SHORT[get("weekday")] ?? 1;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  // "24:00" es la medianoche del día que empieza en algunas configuraciones.
  const hour24 = Number.isFinite(hour) ? hour % 24 : 0;

  return {
    weekday,
    minuteOfDay: hour24 * 60 + (Number.isFinite(minute) ? minute : 0),
    clock: `${two(hour24)}:${two(Number.isFinite(minute) ? minute : 0)}`,
  };
}

/** ¿Estamos en horario laboral del negocio ahora mismo? */
export function isWithinBusinessHours(
  at: Date,
  timezone: string = DEFAULT_TIMEZONE,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
): boolean {
  const { weekday, minuteOfDay } = localTime(at, timezone);
  if (!hours.days.includes(weekday)) return false;
  return minuteOfDay >= hours.startMinute && minuteOfDay < hours.endMinute;
}
