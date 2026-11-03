import type {
  A2APolicyView,
  A2APolicyWriteStatus,
} from "../contracts";
import { HermesClientError } from "../errors";
import { parseA2AAuditHostSnapshot, type A2AAuditHostSnapshot } from "../a2a-audit";
import {
  A2A_POLICY_RESPONSE_MAX_BYTES,
  parseA2APolicyView,
  parseA2APolicyWriteStatus,
  validateA2APeerName,
  validateA2APeerToken,
} from "../a2a-policy";
import {
  parseA2aAgentCard,
  readBoundedJson as readBoundedJsonParser,
} from "../parsers";
import type { HermesClientContext } from "./context";
import type { A2aAgentCard } from "@openedbot/contracts-connector";

/** One fixed, read-only operator verb. No A2A message or generic RPC crosses the link. */
export async function a2aAgentCard(ctx: HermesClientContext): Promise<A2aAgentCard> {
  const response = await ctx.hostRequest("/hermes-setup/a2a/agent-card", { method: "GET" }, "safe", 5_000);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseA2aAgentCard(await readBoundedJsonParser(response, 32 * 1024));
}

/** Read bounded A2A audit metadata from the host root, never a profile path. */
export async function a2aAudit(ctx: HermesClientContext, limit = 50): Promise<A2AAuditHostSnapshot> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("A2A audit limit must be an integer from 1 to 100");
  }
  const query = limit === 50 ? "" : `?limit=${limit}`;
  const response = await ctx.hostRequest(`/hermes-setup/a2a/audit${query}`, { method: "GET" }, "safe", 5_000);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseA2AAuditHostSnapshot(await readBoundedJsonParser(response, 64 * 1024), limit);
}

/** Read the named, metadata-only A2A peer policy from the host root. */
export async function a2aPolicy(ctx: HermesClientContext): Promise<A2APolicyView> {
  const response = await ctx.hostRequest("/hermes-setup/a2a/peers", { method: "GET" }, "safe", 5_000);
  if (!response.ok) await ctx.throwProviderResponse(response);
  return parseA2APolicyView(await readBoundedJsonParser(response, A2A_POLICY_RESPONSE_MAX_BYTES));
}

export async function a2aTrustPeer(ctx: HermesClientContext, name: string, trusted: boolean): Promise<A2APolicyWriteStatus> {
  validateA2APeerName(name);
  if (typeof trusted !== "boolean") throw new TypeError("A2A trust state must be boolean");
  return a2aPolicyWrite(ctx, `/hermes-setup/a2a/peers/${encodeURIComponent(name)}/trust`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trusted }),
  });
}

export async function a2aSetPeerToken(ctx: HermesClientContext, name: string, token: string): Promise<A2APolicyWriteStatus> {
  validateA2APeerName(name);
  validateA2APeerToken(token);
  return a2aPolicyWrite(ctx, `/hermes-setup/a2a/peers/${encodeURIComponent(name)}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function a2aDeletePeerToken(ctx: HermesClientContext, name: string): Promise<A2APolicyWriteStatus> {
  validateA2APeerName(name);
  return a2aPolicyWrite(ctx, `/hermes-setup/a2a/peers/${encodeURIComponent(name)}/token`, { method: "DELETE" });
}

async function a2aPolicyWrite(ctx: HermesClientContext, path: string, init: RequestInit): Promise<A2APolicyWriteStatus> {
  let response: Response;
  try {
    response = await ctx.hostRequest(path, init, "mutation", 5_000);
  } catch (error) {
    if (error instanceof HermesClientError) {
      throw new HermesClientError("The A2A policy write failed.", error.status, "HOST_UNAVAILABLE");
    }
    throw new HermesClientError("The A2A policy write failed.", 502, "HOST_UNAVAILABLE");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HermesClientError("The A2A policy write failed.", response.status, "HOST_UNAVAILABLE");
  }
  try {
    return parseA2APolicyWriteStatus(await readBoundedJsonParser(response, A2A_POLICY_RESPONSE_MAX_BYTES));
  } catch {
    throw new HermesClientError("The A2A policy write could not be verified.", 502, "HERMES_RESPONSE_INVALID");
  }
}
