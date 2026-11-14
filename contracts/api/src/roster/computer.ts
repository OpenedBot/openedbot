/** Capabilities normalized by an adapter from a real response. */
export type ComputerCapability = {
  supported: true;
  canOpen: boolean;
  canCapture: boolean;
};

type UnsupportedComputerCapability = {
  supported: false;
  reason: "COMPUTER_CAPABILITY_UNSUPPORTED";
};

type ComputerCapabilityObservation = ComputerCapability | UnsupportedComputerCapability;

type ComputerBackendStatus =
  | { status: "off" }
  | { status: "provisioning" }
  | { status: "ready" }
  | {
      status: "error";
      reason:
        | "COMPUTER_BACKEND_ERROR"
        | "COMPUTER_PROVISIONING_FAILED"
        | "COMPUTER_CAPTURE_FAILED"
        | "COMPUTER_OPEN_FAILED"
        | "COMPUTER_REFRESH_FAILED";
    };

/**
 * Fully normalized observation. `capability: null` is the required format
 * as long as the backend provides no Computer data.
 */
export type ComputerBackendObservation = {
  capability: ComputerCapabilityObservation | null;
  status?: ComputerBackendStatus;
};

/** Provider-backed, tenant-scoped Computer state for one bot. */
export type BotComputerDto = {
  botId: string;
  /** Derived from the current role; members may observe, not mutate the desktop. */
  canManage: boolean;
  provider: "box" | null;
  observation: ComputerBackendObservation;
  /**
   * Distinct from operator viewing/capture. A desktop MUST NOT be advertised
   * as agent-controllable until Hermes attests a run-scoped binding to this
   * exact provider machine.
   */
  agentControl: {
    status: "unavailable";
    reason: "COMPUTER_PROVIDER_DISABLED" | "COMPUTER_AGENT_CONTROL_NOT_BOUND";
  };
  /** Raw provider state is informational only; clients gate actions on observation. */
  providerState: string | null;
};

/** Fresh one-shot viewer URL. Clients must not persist it. */
export type BotComputerOpenDto = { url: string };

/** A bounded image captured server-side from the real provider desktop. */
export type BotComputerCaptureDto = {
  mediaType: "image/jpeg" | "image/png";
  base64: string;
  capturedAt: string;
};
