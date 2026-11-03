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

/** Une fenêtre de limite fournisseur, telle que l'hôte Hermes la lit. */
export type ProviderUsageWindowDto = {
  label: string;
  /** Pourcentage consommé, jamais une estimation openedbot. */
  usedPercent: number | null;
  resetAt: string | null;
  detail: string | null;
};

/** Le snapshot d'un fournisseur ; les credentials ne quittent jamais l'hôte. */
export type ProviderUsageSnapshotDto = {
  provider: string;
  /** `api_key` : une clé API facturée à l'usage, sans quota de forfait à lire. */
  source: "oauth_usage_api" | "usage_api" | "credits_api" | "api_key" | "unsupported" | "unavailable";
  plan: string | null;
  windows: ProviderUsageWindowDto[];
  details: string[];
  unavailableReason: string | null;
};

/** Réponse publique du cache de lecture des limites d'un runtime. */
export type RuntimeProviderUsageDto = {
  runtimeId: string;
  status: "ok" | "stale" | "loading" | "unsupported" | "disconnected" | "error";
  reason: "feature_absent" | "link_closed" | null;
  fetchedAt: string | null;
  freshUntil: string | null;
  providers: ProviderUsageSnapshotDto[];
  /** Message déjà normalisé, sans réponse ni secret upstream. */
  error: string | null;
};
