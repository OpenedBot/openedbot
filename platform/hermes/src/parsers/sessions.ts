import { createHash } from "node:crypto";
import type {
  HermesSessionCounters,
} from "../contracts";
import { responseInvalid } from "./shared";

export function hermesSessionTitle(id: string, title: string): string {
  const suffix = ` · ${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
  return `${title.slice(0, 200 - suffix.length)}${suffix}`;
}

export function normalizeHermesSessionCounters(input: unknown): HermesSessionCounters {
  const envelope = input && typeof input === "object" ? input as Record<string, unknown> : null;
  const nested = envelope?.session;
  const session = nested && typeof nested === "object" ? nested as Record<string, unknown> : envelope;
  if (!session) throw responseInvalid("Hermes a renvoyé des compteurs de session illisibles.");
  return {
    inputTokens: counter(session.input_tokens),
    outputTokens: counter(session.output_tokens),
    cacheReadTokens: counter(session.cache_read_tokens),
    cacheWriteTokens: counter(session.cache_write_tokens),
  };
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
