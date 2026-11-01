import { readRunKeyWithLabel, signRunKeyWithLabel } from "./routine-run-key";

const BOT_SETTINGS_KEY_LABEL = "ohb:bot-settings-run-key:v1";

export function signBotSettingsRunKey(secret: string, runId: string): string {
  return signRunKeyWithLabel(secret, runId, BOT_SETTINGS_KEY_LABEL);
}

export function readBotSettingsRunKey(secret: string, key: string): string | null {
  return readRunKeyWithLabel(secret, key, BOT_SETTINGS_KEY_LABEL);
}
