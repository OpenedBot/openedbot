/**
 * Server-only messages: what the API writes for a reader, in their language,
 * and that no console screen phrases itself. Same `{name}` interpolation as
 * `t`; a key missing in a locale falls back to French.
 */
import { FALLBACK_LOCALE, type Locale } from "@openedbot/contracts-locale";
import { routineGate as enRoutineGate } from "./server/en";
import { routineGate as frRoutineGate } from "./server/fr";

export type RoutineGateMessageKey = keyof typeof frRoutineGate;

const ROUTINE_GATE: Record<Locale, Record<RoutineGateMessageKey, string>> = { fr: frRoutineGate, en: enRoutineGate };

export function routineGateText(locale: Locale, key: RoutineGateMessageKey, params?: Record<string, string | number>): string {
  let out = ROUTINE_GATE[locale]?.[key] ?? ROUTINE_GATE[FALLBACK_LOCALE][key];
  for (const [name, value] of Object.entries(params ?? {})) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}
