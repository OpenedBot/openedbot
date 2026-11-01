export type A2APolicyAccessMode = "default_allow" | "trusted_peers" | "allow_all_override" | "localhost_only";

export type A2APolicyTrustedPeersSource = "none" | "config" | "environment";

export type A2APolicyDecision = "allow" | "deny";

/** Bounded metadata for one incoming identity or configured outgoing peer. */
export type A2APolicyPeer = {
  name?: string;
  identity: string;
  tokenPresent: boolean;
  access: A2APolicyDecision;
  outgoingConfigured: boolean;
  outgoingTokenPresent: boolean;
  outgoingAccess: A2APolicyDecision;
};

/** Effective A2A policy observed by the running gateway, without credentials or URLs. */
export type A2APolicyView = {
  accessMode: A2APolicyAccessMode;
  trustedPeersSource: A2APolicyTrustedPeersSource;
  processObserved: boolean;
  peers: A2APolicyPeer[];
};

/** Readback from a named host policy write. */
export type A2APolicyWriteStatus = {
  persisted: boolean;
  effective: boolean;
  needsGatewayRestart: boolean;
};
