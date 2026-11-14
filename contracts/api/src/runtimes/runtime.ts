import type { RuntimeReachability } from "./connector";
import type { RuntimeExposureStoredKind } from "./exposures";
import type { RuntimeLinkDto } from "./link";
import type { RuntimeModelSelectionStateDto } from "./models";
import type { HermesReasoningEffort } from "./reasoning-effort";
import type { RuntimeHealthStatus } from "../shared/domain";

export type RuntimePublicDto = {
  id: string | null;
  configured: boolean;
  /** `null` for a `connector` runtime: no URL exists on the cloud side. */
  baseUrl: string | null;
  reachability: RuntimeReachability;
  /** @deprecated Alias of `reachability`, kept one version for older clients. */
  transport: RuntimeReachability;
  /** Connector link state; `null` for a `direct` runtime. */
  link: RuntimeLinkDto | null;
  management: {
    /**
     * `hermes_dashboard`: this deployment's integrated Hermes, written through its
     * local Dashboard. `host`: the client's host offers the edge-setup
     * operator (`provider_management`, announced in `hello` by the link
     * or probed on `GET /hermes-setup/capabilities` directly); provider
     * writes (API key, OAuth) go to that operator: through
     * the connector link, or over HTTPS with the gateway bearer: never over
     * SSH. Over the link, `*Writable` stays false until it is open.
     * `manual`: openedbot does not administer this runtime and the screen points
     * to the gesture to perform on the client's machine.
     */
    kind: "hermes_dashboard" | "host" | "manual";
    credentialsWritable: boolean;
    oauthWritable: boolean;
  };
  name: string | null;
  /** @deprecated Kept for clients older than multi-runtime: read `isActive`. */
  isDefault: boolean;
  /** The runtime that serves runs. At most one per organization, guaranteed in the database. */
  isActive: boolean;
  tokenConfigured: boolean;
  /** A Cloudflare Access service token is stored for this `direct` runtime. Absent on older servers. */
  edgeAuthConfigured?: boolean;
  /**
   * The publication that produced this `direct` row, if it went
   * through the assistant; `null` for access declared by hand or a `connector`.
   */
  exposure?: { id: string; kind: RuntimeExposureStoredKind; hostname: string; lastTunnelStatus: string | null } | null;
  botCount: number;
  selectedProvider: string | null;
  selectedModel: string | null;
  reasoningEffort: HermesReasoningEffort | null;
  detectedVersion: string | null;
  capabilities: Record<string, unknown> | null;
  /** Features announced by the authenticated runtime link/host operator. */
  /** Absent on responses from servers before runtime feature advertisement. */
  linkFeatures?: string[];
  capacity?: number;
  lastHealthStatus: RuntimeHealthStatus;
  lastHealthError?: string | null;
  lastCheckedAt: string | null;
  createdAt?: string | null;
  updatedAt: string | null;
  /**
   * Rewrite of the `model` block of managed profiles that follow the runtime
   * (bots without their own model). Absent if no profile was concerned.
   */
  profileModel?: { applied: boolean };
  /**
   * Model choice recorded but not yet proven (inference test in the
   * background, worker). `selected*` above stays the model IN SERVICE
   * until success; `null` when no proof is in progress or failed.
   * Absent on older servers.
   */
  modelSelection?: RuntimeModelSelectionStateDto | null;
  /**
   * Quota/auth incidents still active on this runtime. Absent on
   * servers older than 0046; an empty array means « none ».
   */
  providerIncidents?: RuntimeProviderIncidentDto[];
};

type RuntimeProviderIncidentKind = "quota" | "auth";

export type RuntimeProviderIncidentDto = {
  provider: string;
  kind: RuntimeProviderIncidentKind;
  firstSeenAt: string;
  lastSeenAt: string;
  until: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  message: string | null;
};
