/** The host's A2A access policy, as `GET/PUT /hermes-setup/a2a-policy` reads and writes it. */

export type A2APolicyAccessMode = "default_allow" | "trusted_peers" | "allow_all_override" | "localhost_only";
export type A2APolicyTrustedPeersSource = "none" | "config" | "environment";
export type A2APolicyDecision = "allow" | "deny";

export type A2APolicyPeer = {
  name?: string;
  identity: string;
  tokenPresent: boolean;
  access: A2APolicyDecision;
  outgoingConfigured: boolean;
  outgoingTokenPresent: boolean;
  outgoingAccess: A2APolicyDecision;
};

export type A2APolicyView = {
  accessMode: A2APolicyAccessMode;
  trustedPeersSource: A2APolicyTrustedPeersSource;
  processObserved: boolean;
  peers: A2APolicyPeer[];
};

export type A2APolicyWriteStatus = {
  persisted: boolean;
  effective: boolean;
  needsGatewayRestart: boolean;
};
