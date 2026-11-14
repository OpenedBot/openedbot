import type { RunKeyVerifier } from "@openedbot/platform-config/internal-secrets";
import { readRunKeyWithLabel, readRunKeyWithVerifiers, signRunKeyWithLabel, type RunKeyRead } from "./routine-run-key";

const BOT_SETTINGS_KEY_LABEL = "openedbot:bot-settings-run-key:v1";

export function signBotSettingsRunKey(secret: string, runId: string): string {
  return signRunKeyWithLabel(secret, runId, BOT_SETTINGS_KEY_LABEL);
}

export function readBotSettingsRunKey(secret: string, key: string): string | null {
  return readRunKeyWithLabel(secret, key, BOT_SETTINGS_KEY_LABEL);
}

export function readBotSettingsRunKeyWith(verifiers: readonly RunKeyVerifier[], key: string): RunKeyRead | null {
  return readRunKeyWithVerifiers(verifiers, key, BOT_SETTINGS_KEY_LABEL);
}
