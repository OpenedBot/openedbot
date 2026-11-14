export type RuntimeProviderCredentialDto = {
  runtimeId: string;
  provider: string;
  label: string;
  verification: "confirmed" | "denied" | "unverified";
  provesInference: boolean;
  detail: string | null;
};

export type RuntimeProviderOauthStatus = "starting" | "pending" | "connected" | "failed" | "cancelled";

export type RuntimeProviderOauthDto = {
  sessionId: string;
  provider: string;
  status: RuntimeProviderOauthStatus;
  verificationUri: string | null;
  userCode: string | null;
  error: string | null;
  expiresAt: string;
};

/** A provider limit window, as the Hermes host reads it. */
export type ProviderUsageWindowDto = {
  label: string;
  /** Percentage consumed, never an openedbot estimate. */
  usedPercent: number | null;
  resetAt: string | null;
  detail: string | null;
};

/** A provider's snapshot; credentials never leave the host. */
export type ProviderUsageSnapshotDto = {
  provider: string;
  /** `api_key`: an API key billed by usage, with no plan quota to read. */
  source: "oauth_usage_api" | "usage_api" | "credits_api" | "api_key" | "unsupported" | "unavailable";
  plan: string | null;
  windows: ProviderUsageWindowDto[];
  details: string[];
  unavailableReason: string | null;
};

/** Public response of a runtime's limit-read cache. */
export type RuntimeProviderUsageDto = {
  runtimeId: string;
  status: "ok" | "stale" | "loading" | "unsupported" | "disconnected" | "error";
  reason: "feature_absent" | "link_closed" | null;
  fetchedAt: string | null;
  freshUntil: string | null;
  providers: ProviderUsageSnapshotDto[];
  /** Message already normalized, with no upstream response or secret. */
  error: string | null;
};
