import { useEffect, useMemo, useRef, useState } from "react";
import { IconArrowDown, IconSend, IconTrash } from "@tabler/icons-react";
import type { VoiceEnvironmentObservation, VoiceOperationalReason } from "@openedbot/browser-face/voice-ui-state";
import { voiceUiState } from "@openedbot/browser-face/voice-ui-state";
import { useT } from "../lib/i18n";
import {
  createBrowserVoiceRecognitionAdapter,
  mergeVoiceTranscript,
  type VoiceRecognitionAdapter,
  type VoiceRecognitionFailure,
} from "../lib/web-voice-recognition";
import { VoicePanel } from "./voice-panel";
import { SpeechOutputSettings } from "./speech-output-settings";
import type { SpeechSynthesisAdapter } from "../lib/web-speech-synthesis";
import { BUTTON } from "./settings/primitives";

export type VoiceDictationProps = {
  adapter?: VoiceRecognitionAdapter;
  speechAdapter?: SpeechSynthesisAdapter;
  callAvailable?: boolean;
  onInsert: (transcript: string) => void | Promise<void>;
  onSend: (transcript: string) => void | Promise<void>;
  sendDisabled?: boolean;
  /**
   * The recognition engine really is listening (not merely the panel open):
   * the composer's mic takes its listening tint from it.
   */
  onListeningChange?: (listening: boolean) => void;
};

function errorReason(failure: VoiceRecognitionFailure): VoiceOperationalReason {
  return failure === "network" ? "VOICE_BACKEND_ERROR" : "VOICE_TRANSCRIPTION_FAILED";
}

/**
 * Dictée réelle de navigateur. Le transcript reste local jusqu'à un clic
 * explicite « insérer » ou « envoyer » ; aucun résultat intermédiaire ne peut
 * démarrer un run tout seul.
 */
export function VoiceDictation({
  adapter: injectedAdapter,
  speechAdapter,
  callAvailable = false,
  onInsert,
  onSend,
  sendDisabled = false,
  onListeningChange,
}: VoiceDictationProps) {
  const { t, locale } = useT();
  const adapter = useMemo(
    () => injectedAdapter ?? createBrowserVoiceRecognitionAdapter(),
    [injectedAdapter],
  );
  const [observation, setObservation] = useState<VoiceEnvironmentObservation>(
    () => adapter.initialObservation(),
  );
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [reviewPending, setReviewPending] = useState<"insert" | "send" | null>(null);
  const [reviewError, setReviewError] = useState(false);
  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const sessionBaseRef = useRef("");
  const cancelledRef = useRef(false);
  const terminalFailureRef = useRef(false);
  // Un refresh Permissions API peut finir après la fermeture du dialogue.
  // Chaque montage reçoit une génération : aucun résultat ou callback d'une
  // génération morte ne peut rouvrir le micro ni écrire dans l'UI démontée.
  const lifecycleGenerationRef = useRef(0);

  const updateTranscript = (finalText: string, interimText: string) => {
    transcriptRef.current = finalText;
    interimRef.current = interimText;
    setTranscript(finalText);
    setInterimTranscript(interimText);
  };

  useEffect(() => {
    const generation = ++lifecycleGenerationRef.current;
    let live = true;
    setObservation(adapter.initialObservation());
    void adapter.refreshObservation().then((next) => {
      if (live) setObservation(next);
    });
    return () => {
      live = false;
      if (lifecycleGenerationRef.current === generation) lifecycleGenerationRef.current += 1;
      adapter.dispose();
    };
  }, [adapter]);

  const start = async () => {
    const generation = lifecycleGenerationRef.current;
    const alive = () => lifecycleGenerationRef.current === generation;
    const refreshed = await adapter.refreshObservation();
    if (!alive()) return;
    setObservation(refreshed);
    if (!refreshed.backend?.supported || !refreshed.microphone?.available) return;

    cancelledRef.current = false;
    terminalFailureRef.current = false;
    sessionBaseRef.current = mergeVoiceTranscript(transcriptRef.current, interimRef.current);
    updateTranscript(sessionBaseRef.current, "");
    setReviewError(false);

    try {
      adapter.start(locale, {
        onStart: () => {
          if (!alive() || cancelledRef.current) return;
          setObservation({
            backend: { supported: true },
            microphone: { available: true },
            phase: { phase: "listening" },
          });
        },
        onResult: (update) => {
          if (!alive() || cancelledRef.current) return;
          const confirmed = mergeVoiceTranscript(sessionBaseRef.current, update.finalTranscript);
          updateTranscript(confirmed, update.interimTranscript);
          setObservation({
            backend: { supported: true },
            microphone: { available: true },
            phase: { phase: "listening" },
          });
        },
        onError: (failure) => {
          if (!alive() || cancelledRef.current) return;
          terminalFailureRef.current = true;
          if (failure === "permission-denied") {
            setObservation({
              backend: { supported: true },
              microphone: { available: false, reason: "VOICE_MICROPHONE_PERMISSION_DENIED" },
            });
            return;
          }
          if (failure === "microphone-unavailable") {
            setObservation({
              backend: { supported: true },
              microphone: { available: false, reason: "VOICE_MICROPHONE_UNAVAILABLE" },
            });
            return;
          }
          setObservation({
            backend: { supported: true },
            microphone: { available: true },
            phase: { phase: "error", reason: errorReason(failure) },
          });
        },
        onEnd: () => {
          if (!alive()) return;
          if (cancelledRef.current) {
            updateTranscript("", "");
            setObservation({
              backend: { supported: true },
              microphone: { available: true },
              phase: { phase: "idle" },
            });
            return;
          }
          if (terminalFailureRef.current) return;
          // Certains moteurs terminent avec un dernier résultat encore marqué
          // provisoire. Une fois le moteur arrêté, il ne l'est plus : le garder
          // évite de perdre les derniers mots prononcés.
          updateTranscript(mergeVoiceTranscript(transcriptRef.current, interimRef.current), "");
          setObservation({
            backend: { supported: true },
            microphone: { available: true },
            phase: { phase: "idle" },
          });
        },
      });
    } catch {
      if (!alive()) return;
      terminalFailureRef.current = true;
      setObservation({
        backend: { supported: true },
        microphone: { available: true },
        phase: { phase: "error", reason: "VOICE_LISTEN_FAILED" },
      });
      throw new Error("VOICE_LISTEN_FAILED");
    }
  };

  const stop = () => {
    setObservation({
      backend: { supported: true },
      microphone: { available: true },
      phase: { phase: "transcribing" },
    });
    try {
      adapter.stop();
    } catch {
      terminalFailureRef.current = true;
      setObservation({
        backend: { supported: true },
        microphone: { available: true },
        phase: { phase: "error", reason: "VOICE_TRANSCRIPTION_FAILED" },
      });
      throw new Error("VOICE_TRANSCRIPTION_FAILED");
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    terminalFailureRef.current = false;
    adapter.cancel();
    updateTranscript("", "");
    setObservation({
      backend: { supported: true },
      microphone: { available: true },
      phase: { phase: "idle" },
    });
  };

  const retry = async () => {
    terminalFailureRef.current = false;
    const refreshed = await adapter.refreshObservation();
    setObservation(refreshed);
  };

  const review = async (action: "insert" | "send") => {
    const text = mergeVoiceTranscript(transcriptRef.current, interimRef.current);
    if (!text || reviewPending) return;
    setReviewPending(action);
    setReviewError(false);
    try {
      await (action === "insert" ? onInsert(text) : onSend(text));
      updateTranscript("", "");
    } catch {
      setReviewError(true);
    } finally {
      setReviewPending(null);
    }
  };

  const state = voiceUiState(observation);
  const reviewing = Boolean(transcript || interimTranscript)
    && state.status !== "listening"
    && state.status !== "transcribing";
  const listening = state.status === "listening";
  const listeningChange = useRef(onListeningChange);
  listeningChange.current = onListeningChange;
  useEffect(() => {
    listeningChange.current?.(listening);
    // Closing the panel unmounts this component: the mic must not stay red.
    return () => listeningChange.current?.(false);
  }, [listening]);
  const browserUnsupported = state.status === "unsupported"
    && state.reason === "VOICE_CAPABILITY_UNSUPPORTED";

  return (
    <div className="space-y-3">
      <VoicePanel
        observation={observation}
        transcript={transcript}
        interimTranscript={interimTranscript}
        unsupportedMessage={browserUnsupported ? t("voicePanel.browserUnsupported") : undefined}
        showRuntimeSettings={false}
        onStart={start}
        onStop={stop}
        onRetry={retry}
        onCancel={cancel}
      />

      <SpeechOutputSettings adapter={speechAdapter} callAvailable={callAvailable} />

      {state.status !== "unsupported" ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t("voicePanel.browserPrivacy")}
        </p>
      ) : null}

      {reviewing ? (
        <div className="flex flex-wrap gap-2" aria-label={t("voicePanel.transcriptActions")}>
          <button
            type="button"
            disabled={reviewPending !== null}
            onClick={() => void review("insert")}
            className={BUTTON.secondary}
          >
            <IconArrowDown className="size-4" aria-hidden />
            {reviewPending === "insert" ? t("voicePanel.inserting") : t("voicePanel.insert")}
          </button>
          <button
            type="button"
            disabled={reviewPending !== null || sendDisabled}
            onClick={() => void review("send")}
            className={BUTTON.primary}
          >
            <IconSend className="size-4" aria-hidden />
            {reviewPending === "send" ? t("voicePanel.sending") : t("voicePanel.send")}
          </button>
          <button
            type="button"
            disabled={reviewPending !== null}
            onClick={() => updateTranscript("", "")}
            className={BUTTON.secondary}
          >
            <IconTrash className="size-4" aria-hidden />
            {t("voicePanel.discard")}
          </button>
        </div>
      ) : null}

      {reviewError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {t("voicePanel.reviewFailed")}
        </p>
      ) : null}
    </div>
  );
}
