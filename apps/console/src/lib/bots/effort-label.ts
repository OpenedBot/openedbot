import type { HermesReasoningEffort } from "@openedbot/contracts-api";
import type { MessageKey } from "../i18n";

/**
 * The six levels Hermes accepts, in the interface's language.
 * `HERMES_REASONING_EFFORT_LABELS` stays the wire vocabulary (English, for
 * logs and the API); a screen always goes through here.
 */
const EFFORT_KEYS: Record<HermesReasoningEffort, MessageKey> = {
  none: "composer.effortNone",
  minimal: "composer.effortMinimal",
  low: "composer.effortLow",
  medium: "composer.effortMedium",
  high: "composer.effortHigh",
  xhigh: "composer.effortXhigh",
};

export function effortLabel(t: (key: MessageKey) => string, effort: HermesReasoningEffort): string {
  return t(EFFORT_KEYS[effort]);
}
