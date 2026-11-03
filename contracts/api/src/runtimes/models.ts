import type { HermesReasoningEffort } from "./reasoning-effort";

export type RuntimeModelSelectionInput = {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

/**
 * `queued` : en file (ou le runtime est occupé, nouvel essai à `nextAttemptAt`).
 * `running` : le test d'inférence tourne. `failed` : refusé, le modèle en
 * service n'a pas changé; reste affiché jusqu'au prochain choix ou à son rejet.
 */
export type RuntimeModelSelectionStatus = "queued" | "running" | "failed";

export type RuntimeModelSelectionStateDto = {
  status: RuntimeModelSelectionStatus;
  provider: string | null;
  model: string | null;
  reasoningEffort: HermesReasoningEffort | null;
  requestedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  error: { code: string; message: string } | null;
};

export type RuntimeModelDto = {
  id: string;
  fast: boolean;
  reasoning: boolean;
  isRuntimeDefault: boolean;
  freeTier: { tokensPerDay: number | null } | null;
};

export type RuntimeModelProviderDto = {
  slug: string;
  name: string;
  isCurrent: boolean;
  authenticated: boolean;
  alwaysAuthenticated: boolean;
  provesInference: boolean;
  acceptsApiKey: boolean;
  acceptsOauth: boolean;
  /** `false`: the SDK connector is not installed on the host, the provider cannot run. `null`: unknown (feature not announced, or the read failed). */
  sdkInstalled: boolean | null;
  /** `true`: `sudo edge-setup up` installs the missing connector. `null` when `sdkInstalled` is `null`. */
  sdkInstallable: boolean | null;
  warning: string | null;
  authCommand: string | null;
  models: RuntimeModelDto[];
};

export type RuntimeModelCatalogDto = {
  runtimeId: string;
  runtimeName: string;
  hermesProfile: string | null;
  currentProvider: string | null;
  runtimeDefaultModel: string | null;
  hasUsableProvider: boolean;
  providers: RuntimeModelProviderDto[];
  runtimeConfigWritable: false;
};
