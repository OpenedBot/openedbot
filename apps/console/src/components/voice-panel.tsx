import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlayerStop,
  IconRefresh,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import {
  reduceVoiceUiState,
  voiceActionDecision,
  voiceUiActions,
  voiceUiState,
  type VoiceEnvironmentObservation,
  type VoiceOperationalReason,
  type VoiceReasonCode,
  type VoiceUiAction,
  type VoiceUiState,
} from "@openedbot/browser-face/voice-ui-state";
import { useT, type MessageKey } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

type VoiceCallback = () => void | Promise<void>;

export type VoicePanelProps = {
  observation: VoiceEnvironmentObservation;
  runtimeSettingsHref?: string;
  /** Transcription confirmée et segment provisoire fournis par un vrai adaptateur. */
  transcript?: string;
  interimTranscript?: string;
  /** Le refus peut venir du navigateur, et non du runtime Hermes. */
  unsupportedMessage?: string;
  showRuntimeSettings?: boolean;
  onStart?: VoiceCallback;
  onStop?: VoiceCallback;
  onRetry?: VoiceCallback;
  onCancel?: VoiceCallback;
};

const STATUS_KEYS: Record<VoiceUiState["status"], MessageKey> = {
  unsupported: "voicePanel.status.unsupported",
  idle: "voicePanel.status.idle",
  listening: "voicePanel.status.listening",
  transcribing: "voicePanel.status.transcribing",
  sending: "voicePanel.status.sending",
  error: "voicePanel.status.error",
};

const REASON_KEYS: Record<VoiceReasonCode, MessageKey> = {
  VOICE_CAPABILITY_NOT_REPORTED: "voicePanel.reason.capabilityNotReported",
  VOICE_CAPABILITY_UNSUPPORTED: "voicePanel.reason.capabilityUnsupported",
  VOICE_MICROPHONE_NOT_REPORTED: "voicePanel.reason.microphoneNotReported",
  VOICE_MICROPHONE_UNAVAILABLE: "voicePanel.reason.microphoneUnavailable",
  VOICE_MICROPHONE_PERMISSION_DENIED: "voicePanel.reason.microphonePermissionDenied",
  VOICE_BACKEND_ERROR: "voicePanel.reason.backendError",
  VOICE_LISTEN_FAILED: "voicePanel.reason.listenFailed",
  VOICE_TRANSCRIPTION_FAILED: "voicePanel.reason.transcriptionFailed",
  VOICE_SEND_FAILED: "voicePanel.reason.sendFailed",
  VOICE_CANCEL_FAILED: "voicePanel.reason.cancelFailed",
};

/**
 * Surface Voice web autonome, sans acquisition ni transport de media.
 *
 * Le parent adapte les faits backend/microphone et execute les callbacks. Ce
 * composant ne contient aucun transcript et ne peut pas inventer le passage
 * `transcribing -> sending`; seule une nouvelle observation reelle le fait.
 */
export function VoicePanel({
  observation,
  runtimeSettingsHref = "/settings/runtime",
  transcript = "",
  interimTranscript = "",
  unsupportedMessage,
  showRuntimeSettings = true,
  onStart,
  onStop,
  onRetry,
  onCancel,
}: VoicePanelProps) {
  const { t } = useT();
  const [state, setState] = useState(() => voiceUiState(observation));
  const [pending, setPending] = useState<VoiceUiAction | null>(null);
  const [callbackFailed, setCallbackFailed] = useState(false);

  useEffect(() => {
    setState((current) => reduceVoiceUiState(current, { type: "environment.synced", observation }));
    setCallbackFailed(false);
  }, [observation]);

  const actions = voiceUiActions(state);
  const busy = pending !== null;

  const invoke = async (
    action: VoiceUiAction,
    callback: VoiceCallback | undefined,
    failureReason: VoiceOperationalReason,
  ) => {
    if (!callback || !voiceActionDecision(state, action).accepted) return;
    setPending(action);
    setCallbackFailed(false);
    if (action === "stop") {
      setState((current) => reduceVoiceUiState(current, { type: "stop.requested" }));
    } else if (action === "retry") {
      setState((current) => reduceVoiceUiState(current, { type: "retry.requested" }));
    } else {
      setState((current) => reduceVoiceUiState(current, { type: "cancel.requested" }));
    }
    try {
      await callback();
    } catch {
      setCallbackFailed(true);
      setState((current) => reduceVoiceUiState(current, {
        type: "operation.failed",
        reason: failureReason,
      }));
    } finally {
      setPending(null);
    }
  };

  const reasonKey = state.reason ? REASON_KEYS[state.reason] : null;

  return (
    <section
      aria-labelledby="voice-panel-title"
      aria-busy={busy}
      className="rounded-xl border border-border bg-card p-4"
      data-voice-status={state.status}
    >
      <header className="flex items-start gap-3">
        <span className="rounded-lg bg-muted p-2 text-muted-foreground">
          {state.status === "unsupported" ? (
            <IconMicrophoneOff className="size-5" aria-hidden />
          ) : state.status === "error" ? (
            <IconAlertTriangle className="size-5 text-destructive-text" aria-hidden />
          ) : (
            <IconMicrophone className="size-5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="voice-panel-title" className="font-medium">{t("voicePanel.title")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
            {t(STATUS_KEYS[state.status])}
          </p>
        </div>
      </header>

      <div className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3">
        {transcript || interimTranscript ? (
          <div role="status" aria-live="polite" aria-label={t("voicePanel.transcriptLabel")}>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("voicePanel.transcriptLabel")}
            </p>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {transcript}
              {transcript && interimTranscript ? " " : null}
              {interimTranscript ? (
                <span className="text-muted-foreground">{interimTranscript}</span>
              ) : null}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {state.status === "unsupported" && unsupportedMessage
              ? unsupportedMessage
              : reasonKey
                ? t(reasonKey)
                : t("voicePanel.noTranscript")}
          </p>
        )}
        {callbackFailed ? (
          <p role="alert" className="mt-2 text-sm text-destructive-text">
            {t("voicePanel.callbackFailed")}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {actions.includes("start") && onStart ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void invoke("start", onStart, "VOICE_LISTEN_FAILED")}
            className={BUTTON.secondary}
          >
            <IconMicrophone className="size-4" aria-hidden />
            {t("voicePanel.start")}
          </button>
        ) : null}
        {actions.includes("stop") && onStop ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void invoke("stop", onStop, "VOICE_TRANSCRIPTION_FAILED")}
            className={BUTTON.secondary}
          >
            <IconPlayerStop className="size-4" aria-hidden />
            {t("voicePanel.stop")}
          </button>
        ) : null}
        {actions.includes("retry") && onRetry ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void invoke("retry", onRetry, "VOICE_BACKEND_ERROR")}
            className={BUTTON.secondary}
          >
            <IconRefresh className="size-4" aria-hidden />
            {t("voicePanel.retry")}
          </button>
        ) : null}
        {actions.includes("cancel") && onCancel ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void invoke("cancel", onCancel, "VOICE_CANCEL_FAILED")}
            className={BUTTON.secondary}
          >
            <IconX className="size-4" aria-hidden />
            {t("voicePanel.cancel")}
          </button>
        ) : null}
        {state.status === "unsupported" && showRuntimeSettings ? (
          <a href={runtimeSettingsHref} className={BUTTON.secondary}>
            <IconSettings className="size-4" aria-hidden />
            <span>{t("voicePanel.configureRuntime")}</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
