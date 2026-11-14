/**
 * Machine d'etat Voice partagee, pure et sans media.
 *
 * Elle ne connait ni API, ni permission native, ni WebAudio. Elle ne contient
 * jamais de transcript, d'octets audio ou d'URI : les adaptateurs gardent ces
 * donnees hors de ce contrat et ne signalent que des faits observes.
 */

export const VOICE_REASON_CODES = [
  "VOICE_CAPABILITY_NOT_REPORTED",
  "VOICE_CAPABILITY_UNSUPPORTED",
  "VOICE_MICROPHONE_NOT_REPORTED",
  "VOICE_MICROPHONE_UNAVAILABLE",
  "VOICE_MICROPHONE_PERMISSION_DENIED",
  "VOICE_BACKEND_ERROR",
  "VOICE_LISTEN_FAILED",
  "VOICE_TRANSCRIPTION_FAILED",
  "VOICE_SEND_FAILED",
  "VOICE_CANCEL_FAILED",
] as const;

export type VoiceReasonCode = (typeof VOICE_REASON_CODES)[number];

export type VoiceBackendCapability =
  | { supported: true }
  | { supported: false; reason: "VOICE_CAPABILITY_UNSUPPORTED" };

export type VoiceMicrophoneCapability =
  | { available: true }
  | {
      available: false;
      reason: "VOICE_MICROPHONE_UNAVAILABLE" | "VOICE_MICROPHONE_PERMISSION_DENIED";
    };

export type VoiceOperationalReason = Exclude<VoiceReasonCode,
  | "VOICE_CAPABILITY_NOT_REPORTED"
  | "VOICE_CAPABILITY_UNSUPPORTED"
  | "VOICE_MICROPHONE_NOT_REPORTED"
  | "VOICE_MICROPHONE_UNAVAILABLE"
  | "VOICE_MICROPHONE_PERMISSION_DENIED">;

export type VoiceBackendPhase =
  | { phase: "idle" }
  | { phase: "listening" }
  | { phase: "transcribing" }
  | { phase: "sending" }
  | { phase: "error"; reason: VoiceOperationalReason };

/** Observation normalisee par un adaptateur depuis des faits reels. */
export type VoiceEnvironmentObservation = {
  backend: VoiceBackendCapability | null;
  microphone: VoiceMicrophoneCapability | null;
  phase?: VoiceBackendPhase;
};

type ReadyVoiceEnvironment = {
  backend: { supported: true };
  microphone: { available: true };
};

type SupportedVoiceState = { environment: ReadyVoiceEnvironment };

export type VoiceUiState =
  | {
      status: "unsupported";
      reason:
        | "VOICE_CAPABILITY_NOT_REPORTED"
        | "VOICE_CAPABILITY_UNSUPPORTED"
        | "VOICE_MICROPHONE_NOT_REPORTED"
        | "VOICE_MICROPHONE_UNAVAILABLE"
        | "VOICE_MICROPHONE_PERMISSION_DENIED";
      environment: null;
    }
  | (SupportedVoiceState & { status: "idle"; reason: null })
  | (SupportedVoiceState & { status: "listening"; reason: null })
  | (SupportedVoiceState & { status: "transcribing"; reason: null })
  | (SupportedVoiceState & { status: "sending"; reason: null })
  | (SupportedVoiceState & { status: "error"; reason: VoiceOperationalReason });

export type VoiceUiAction = "start" | "stop" | "retry" | "cancel";

export type VoiceUiEvent =
  | { type: "environment.synced"; observation: VoiceEnvironmentObservation }
  | { type: "start.requested" }
  | { type: "stop.requested" }
  /** A emettre seulement apres obtention d'un transcript reel, jamais sur timeout. */
  | { type: "transcript.available" }
  | { type: "send.completed" }
  | { type: "retry.requested" }
  | { type: "cancel.requested" }
  | { type: "operation.failed"; reason: VoiceOperationalReason };

export type VoiceActionRefusal =
  | "VOICE_CAPABILITY_NOT_REPORTED"
  | "VOICE_CAPABILITY_UNSUPPORTED"
  | "VOICE_MICROPHONE_NOT_REPORTED"
  | "VOICE_MICROPHONE_UNAVAILABLE"
  | "VOICE_MICROPHONE_PERMISSION_DENIED"
  | "VOICE_ACTION_NOT_AVAILABLE";

export type VoiceActionDecision =
  | { accepted: true }
  | { accepted: false; reason: VoiceActionRefusal };

/** Projection fail-closed de l'environnement vers la machine UI. */
export function voiceUiState(observation: VoiceEnvironmentObservation): VoiceUiState {
  const backend = observation.backend;
  if (backend === null) {
    return { status: "unsupported", reason: "VOICE_CAPABILITY_NOT_REPORTED", environment: null };
  }
  if (!backend.supported) {
    return { status: "unsupported", reason: backend.reason, environment: null };
  }
  const microphone = observation.microphone;
  if (microphone === null) {
    return { status: "unsupported", reason: "VOICE_MICROPHONE_NOT_REPORTED", environment: null };
  }
  if (!microphone.available) {
    return { status: "unsupported", reason: microphone.reason, environment: null };
  }

  const environment: ReadyVoiceEnvironment = { backend, microphone };
  const phase = observation.phase;
  if (!phase || phase.phase === "idle") return { status: "idle", reason: null, environment };
  if (phase.phase === "listening") return { status: "listening", reason: null, environment };
  if (phase.phase === "transcribing") return { status: "transcribing", reason: null, environment };
  if (phase.phase === "sending") return { status: "sending", reason: null, environment };
  return { status: "error", reason: phase.reason, environment };
}

/** Actions qu'une interface peut presenter, sans deviner une permission. */
export function voiceUiActions(state: VoiceUiState): readonly VoiceUiAction[] {
  switch (state.status) {
    case "unsupported":
      return [];
    case "idle":
      return ["start"];
    case "listening":
      return ["stop", "cancel"];
    case "transcribing":
    case "sending":
      return ["cancel"];
    case "error":
      return ["retry", "cancel"];
  }
}

/** Gate a rappeler juste avant chaque effet, y compris si le bouton etait deja rendu. */
export function voiceActionDecision(state: VoiceUiState, action: VoiceUiAction): VoiceActionDecision {
  if (state.status === "unsupported") return { accepted: false, reason: state.reason };
  return voiceUiActions(state).includes(action)
    ? { accepted: true }
    : { accepted: false, reason: "VOICE_ACTION_NOT_AVAILABLE" };
}

/** Reducer pur; capture, transcription et envoi restent des effets d'adaptateur. */
export function reduceVoiceUiState(state: VoiceUiState, event: VoiceUiEvent): VoiceUiState {
  if (event.type === "environment.synced") return voiceUiState(event.observation);
  if (state.status === "unsupported") return state;

  switch (event.type) {
    case "start.requested":
      return voiceActionDecision(state, "start").accepted
        ? { status: "listening", reason: null, environment: state.environment }
        : state;
    case "stop.requested":
      return voiceActionDecision(state, "stop").accepted
        ? { status: "transcribing", reason: null, environment: state.environment }
        : state;
    case "transcript.available":
      return state.status === "transcribing"
        ? { status: "sending", reason: null, environment: state.environment }
        : state;
    case "send.completed":
      return state.status === "sending"
        ? { status: "idle", reason: null, environment: state.environment }
        : state;
    case "retry.requested":
      return voiceActionDecision(state, "retry").accepted
        ? { status: "idle", reason: null, environment: state.environment }
        : state;
    case "cancel.requested":
      return voiceActionDecision(state, "cancel").accepted
        ? { status: "idle", reason: null, environment: state.environment }
        : state;
    case "operation.failed":
      return { status: "error", reason: event.reason, environment: state.environment };
  }
}
