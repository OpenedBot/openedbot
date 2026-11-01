import { HERMES_RUN_STATUSES } from "../contracts";
import type {
  HermesRunDetails,
  HermesRunStatus,
} from "../contracts";
import { HermesClientError } from "../errors";
import { responseInvalid } from "./shared";

export function normalizeHermesRunDetails(input: unknown, fallbackId: string): HermesRunDetails {
  if (!input || typeof input !== "object") throw invalidRunStatus();
  const body = input as Record<string, unknown>;
  if (!HERMES_RUN_STATUSES.includes(body.status as HermesRunStatus)) throw invalidRunStatus();
  if (body.run_id !== undefined && (typeof body.run_id !== "string" || !body.run_id)) throw invalidRunStatus();
  if (body.output !== undefined && body.output !== null && typeof body.output !== "string") throw invalidRunStatus();
  let usage: HermesRunDetails["usage"] = null;
  if (body.usage !== undefined && body.usage !== null) {
    if (!body.usage || typeof body.usage !== "object") throw invalidRunStatus();
    const raw = body.usage as Record<string, unknown>;
    const inputTokens = optionalNonNegativeNumber(raw.input_tokens);
    const outputTokens = optionalNonNegativeNumber(raw.output_tokens);
    const totalTokens = optionalNonNegativeNumber(raw.total_tokens);
    if (inputTokens === null || outputTokens === null || totalTokens === null) throw invalidRunStatus();
    usage = {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    };
  }
  return {
    id: typeof body.run_id === "string" ? body.run_id : fallbackId,
    status: body.status as HermesRunStatus,
    output: typeof body.output === "string" ? body.output : null,
    usage,
    pendingSteer: pendingSteerText(body.pending_steer),
  };
}

/** Un `pending_steer` absent, nul ou vide dit la même chose : rien à rejouer. */
export function pendingSteerText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function invalidRunStatus(): HermesClientError {
  return responseInvalid("Hermes a renvoyé un état de run invalide.");
}

function optionalNonNegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
