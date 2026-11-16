import { formatDate, type Locale } from "@openedbot/browser-i18n";

/**
 * Time read in the forecast location's zone, never the viewer's: « 14 h »
 * and « Aujourd'hui » must mean the same thing for someone in Rennes and for
 * someone reading about Rennes from Montréal.
 */

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    clockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export type ZonedClock = { dayKey: string; hour: number; minute: number };

export function zonedClock(ms: number, timeZone: string): ZonedClock {
  const parts: Record<string, string> = {};
  for (const part of clockFormatter(timeZone).formatToParts(ms)) parts[part.type] = part.value;
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function zonedDayKey(ms: number, timeZone: string): string {
  return zonedClock(ms, timeZone).dayKey;
}

/**
 * « 14 h » / « 2 PM », never zero-padded (« 8 h », « 0 h », « 8 AM »). Built
 * from the zoned hour rather than `Intl`, whose French « 08 h » pads it.
 */
export function hourLabel(locale: Locale, ms: number, timeZone: string): string {
  const { hour } = zonedClock(ms, timeZone);
  if (locale === "fr") return `${hour} h`;
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** « 17:28 » / « 5:28 PM ». */
export function clockLabel(locale: Locale, ms: number, timeZone: string): string {
  return formatDate(locale, ms, { hour: "numeric", minute: "2-digit", timeZone });
}

/**
 * « mar. » / « Tue » for a calendar day. The day key is already in the
 * location's zone, so it is read at noon UTC: no offset can move it.
 */
export function weekdayLabel(locale: Locale, dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  return formatDate(locale, Date.UTC(year, month - 1, day, 12), { weekday: "short", timeZone: "UTC" });
}
