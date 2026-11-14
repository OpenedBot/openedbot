import type { HermesReasoningEffort } from "./reasoning-effort";

export type RuntimeModelSelectionInput = {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

/**
 * `queued`: in queue (or the runtime is busy, a new attempt at `nextAttemptAt`).
 * `running`: the inference test is running. `failed`: refused, the model in
 * service has not changed; stays displayed until the next choice or its dismissal.
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
  /**
   * The model a bot with no model of its own runs on, by the worker's own rule
   * (`resolveRunnableSelection`, active quota incidents included): the host's
   * default when it is usable, otherwise the one openedbot picks
   * (`source: "openedbot"`). Computed on every response, outside the snapshot.
   * `null`: no provider can serve a run. It names a model, it does not promise
   * a run: a chosen provider that lost its login still fails the run first
   * (`PROVIDER_AUTH_REQUIRED`).
   */
  automaticModel?: { provider: string; model: string; source: "host" | "openedbot" } | null;
  hasUsableProvider: boolean;
  providers: RuntimeModelProviderDto[];
  runtimeConfigWritable: false;
};
