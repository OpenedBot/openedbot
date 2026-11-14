import { isIP } from "node:net";
import { HermesClientError } from "./errors";
import type { A2APolicyPeer, A2APolicyView, A2APolicyWriteStatus } from "./a2a-policy-types";

const MAX_A2A_POLICY_PEERS = 96;
const MAX_A2A_POLICY_BODY_BYTES = 64 * 1024;
const peerNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function invalidA2APolicyResponse(): HermesClientError {
  return new HermesClientError("The A2A policy response is invalid.", 502, "HERMES_RESPONSE_INVALID");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPeerName(value: string): boolean {
  return peerNamePattern.test(value) && !value.includes("..");
}

function isPeerIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128 || value.trim() !== value
    || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return false;
  if (isPeerName(value)) return true;
  if (value === "ip:local" || value === "ip:unknown") return true;
  return value.startsWith("ip:") && isIP(value.slice(3)) !== 0;
}

export function validateA2APeerName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isPeerName(value)) {
    throw new RangeError("A2A peer name is invalid");
  }
}

export function validateA2APeerToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 256
    || !/^[\x21-\x7e]+$/.test(value) || value.includes(",")) {
    throw new RangeError("A2A peer token must contain 32 to 256 printable ASCII characters without commas");
  }
}

/** Strictly validates a host policy view and returns only its public metadata. */
export function parseA2APolicyView(value: unknown): A2APolicyView {
  const view = objectRecord(value);
  if (!view
    || typeof view.accessMode !== "string"
    || !["default_allow", "trusted_peers", "allow_all_override", "localhost_only"].includes(view.accessMode)
    || typeof view.trustedPeersSource !== "string"
    || !["none", "config", "environment"].includes(view.trustedPeersSource)
    || typeof view.processObserved !== "boolean"
    || !Array.isArray(view.peers)
    || view.peers.length > MAX_A2A_POLICY_PEERS) {
    throw invalidA2APolicyResponse();
  }

  const identities = new Set<string>();
  const peers = view.peers.map((raw): A2APolicyPeer => {
    const peer = objectRecord(raw);
    if (!peer || !isPeerIdentity(peer.identity)
      || (peer.name !== undefined && (typeof peer.name !== "string" || !isPeerName(peer.name)))
      || typeof peer.tokenPresent !== "boolean"
      || (peer.access !== "allow" && peer.access !== "deny")
      || typeof peer.outgoingConfigured !== "boolean"
      || typeof peer.outgoingTokenPresent !== "boolean"
      || (peer.outgoingAccess !== "allow" && peer.outgoingAccess !== "deny")
      || identities.has(peer.identity)) {
      throw invalidA2APolicyResponse();
    }
    if ((peer.name !== undefined && (peer.identity.startsWith("ip:") || peer.name !== peer.identity))
      || (!view.processObserved && peer.outgoingAccess === "allow")
      || (!peer.outgoingConfigured && (peer.outgoingTokenPresent || peer.outgoingAccess === "allow"))) {
      throw invalidA2APolicyResponse();
    }
    identities.add(peer.identity);
    return {
      ...(peer.name === undefined ? {} : { name: peer.name }),
      identity: peer.identity,
      tokenPresent: peer.tokenPresent,
      access: peer.access,
      outgoingConfigured: peer.outgoingConfigured,
      outgoingTokenPresent: peer.outgoingTokenPresent,
      outgoingAccess: peer.outgoingAccess,
    };
  });

  return {
    accessMode: view.accessMode as A2APolicyView["accessMode"],
    trustedPeersSource: view.trustedPeersSource as A2APolicyView["trustedPeersSource"],
    processObserved: view.processObserved,
    peers,
  };
}

/** Write readback must distinguish effective changes from a required restart. */
export function parseA2APolicyWriteStatus(value: unknown): A2APolicyWriteStatus {
  const status = objectRecord(value);
  if (!status || typeof status.persisted !== "boolean" || typeof status.effective !== "boolean"
    || typeof status.needsGatewayRestart !== "boolean"
    || (!status.persisted && (status.effective || status.needsGatewayRestart))
    || (status.persisted && status.effective && status.needsGatewayRestart)
    || (status.persisted && !status.effective && !status.needsGatewayRestart)) {
    throw invalidA2APolicyResponse();
  }
  return {
    persisted: status.persisted,
    effective: status.effective,
    needsGatewayRestart: status.needsGatewayRestart,
  };
}

export const A2A_POLICY_RESPONSE_MAX_BYTES = MAX_A2A_POLICY_BODY_BYTES;
