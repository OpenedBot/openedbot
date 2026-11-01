import { useEffect, useMemo, useRef, useState } from "react";
import { IconPhone, IconPhoneOff, IconSend, IconVolume } from "@tabler/icons-react";
import type { ProductRunStatus, ThreadMessageDto } from "@openedbot/contracts-api";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import { useT, type MessageKey } from "../lib/i18n";
import { markdownToSpeechText } from "../lib/speech-text";
import { normalizeChoice } from "../lib/format";
import {
  createBrowserVoiceRecognitionAdapter,
  mergeVoiceTranscript,
  type VoiceRecognitionAdapter,
} from "../lib/web-voice-recognition";
import {
  createBrowserSpeechSynthesisAdapter,
  readSpeechOutputSettings,
  type SpeechSynthesisAdapter,
} from "../lib/web-speech-synthesis";
import { SpeechOutputSettings } from "./speech-output-settings";
import { BUTTON } from "./settings/primitives";

export type VoiceCallResponse = { id: string; runId: string | null; text: string };
export type VoiceCallApproval = {
  id: string;
  runId: string;
  action: string;
  choices: readonly ("once" | "deny")[];
};
export type VoiceCallRun = { id: string; status: ProductRunStatus; error?: string | null };
type CallPhase = "idle" | "approval" | "listening" | "sending" | "working" | "speaking" | "error";
const RUN_OBSERVATION_GRACE_MS = 30_000;
const LISTEN_START_TIMEOUT_MS = 30_000;

/** La sortie d'un run n'est jamais une bulle : seule la ligne persistée parle. */
export function latestAssistantVoiceResponse(
  messages: readonly ThreadMessageDto[],
): VoiceCallResponse | null {
  return assistantVoiceResponses(messages).at(-1) ?? null;
}

export function assistantVoiceResponses(
  messages: readonly ThreadMessageDto[],
): VoiceCallResponse[] {
  return messages.flatMap((message) => message.role === "assistant" ? [{
    id: message.id,
    runId: message.runId,
    text: message.content.map((part) => part.type === "text" ? part.text : "").join(""),
  }] : []);
}

export function VoiceCall({
  responses,
  approval = null,
  runs = [],
  disabled = false,
  voiceId = null,
  onSend,
  onApproval,
  onActiveChange,
  recognitionAdapter: injectedRecognition,
  speechAdapter: injectedSpeech,
}: {
  responses: readonly VoiceCallResponse[];
  approval?: VoiceCallApproval | null;
  runs?: readonly VoiceCallRun[];
  disabled?: boolean;
  /** Voix persistée du bot ; l'adaptateur retombe sur langue/client si absente. */
  voiceId?: string | null;
  onSend: (transcript: string) => Promise<{ runId: string }>;
  onApproval?: (approvalId: string, choice: "once" | "deny") => void | Promise<void>;
  onActiveChange?: (active: boolean) => void;
  recognitionAdapter?: VoiceRecognitionAdapter;
  speechAdapter?: SpeechSynthesisAdapter;
}) {
  const { t, locale } = useT();
  const recognition = useMemo(
    () => injectedRecognition ?? createBrowserVoiceRecognitionAdapter(),
    [injectedRecognition],
  );
  const speech = useMemo(
    () => injectedSpeech ?? createBrowserSpeechSynthesisAdapter(),
    [injectedSpeech],
  );
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const session = useRef(0);
  const turn = useRef(0);
  const activeRef = useRef(false);
  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const responsesRef = useRef(responses);
  const approvalRef = useRef(approval);
  const approvalTurnRef = useRef<VoiceCallApproval | null>(null);
  const promptedApprovalId = useRef<string | null>(null);
  const speechPurposeRef = useRef<{ kind: "response" } | { kind: "approval"; approval: VoiceCallApproval } | null>(null);
  const expectedResponseId = useRef<string | null>(responses.at(-1)?.id ?? null);
  const expectedRunId = useRef<string | null>(null);
  const pendingTimers = useRef(new Set<number>());

  useEffect(() => { responsesRef.current = responses; }, [responses]);
  useEffect(() => { approvalRef.current = approval; }, [approval]);
  useEffect(() => {
    onActiveChange?.(active);
    return () => {
      if (active) onActiveChange?.(false);
    };
  }, [active, onActiveChange]);

  const alive = (sessionId: number, turnId?: number) =>
    activeRef.current && session.current === sessionId && (turnId === undefined || turn.current === turnId);

  const clearTranscript = () => {
    transcriptRef.current = "";
    interimRef.current = "";
    setTranscript("");
    setInterim("");
  };

  const clearTimer = (timer: number | undefined) => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    pendingTimers.current.delete(timer);
  };

  const shutdownMedia = () => {
    turn.current += 1;
    approvalTurnRef.current = null;
    speechPurposeRef.current = null;
    for (const timer of pendingTimers.current) window.clearTimeout(timer);
    pendingTimers.current.clear();
    recognition.cancel();
    recognition.dispose();
    speech.cancel();
  };

  const fail = (key: MessageKey) => {
    activeRef.current = false;
    setActive(false);
    setStarting(false);
    setPhase("error");
    setErrorKey(key);
    shutdownMedia();
  };

  const beginListening = async (sessionId: number) => {
    let refreshTimer: number | undefined;
    let observation;
    try {
      observation = await Promise.race([
        recognition.refreshObservation(),
        new Promise<null>((resolve) => {
          refreshTimer = window.setTimeout(() => resolve(null), LISTEN_START_TIMEOUT_MS);
          pendingTimers.current.add(refreshTimer);
        }),
      ]);
    } catch {
      clearTimer(refreshTimer);
      if (alive(sessionId)) fail("voicePanel.callListenFailed");
      return;
    }
    clearTimer(refreshTimer);
    if (!alive(sessionId)) return;
    if (!observation) {
      fail("voicePanel.callListenFailed");
      return;
    }
    if (!observation.backend?.supported || !observation.microphone?.available) {
      fail(observation.microphone && !observation.microphone.available
        && observation.microphone.reason === "VOICE_MICROPHONE_PERMISSION_DENIED"
        ? "voicePanel.reason.microphonePermissionDenied"
        : "voicePanel.callUnavailableBrowser");
      return;
    }
    const turnId = ++turn.current;
    let startTimer = window.setTimeout(() => {
      pendingTimers.current.delete(startTimer);
      if (alive(sessionId, turnId)) fail("voicePanel.callListenFailed");
    }, LISTEN_START_TIMEOUT_MS);
    pendingTimers.current.add(startTimer);
    const clearStartTimer = () => {
      clearTimer(startTimer);
      startTimer = 0;
    };
    try {
      recognition.start(locale, {
        onStart: () => {
          clearStartTimer();
          if (!alive(sessionId, turnId)) return;
          setStarting(false);
          setPhase("listening");
        },
        onResult: (update) => {
          clearStartTimer();
          if (!alive(sessionId, turnId)) return;
          transcriptRef.current = update.finalTranscript;
          interimRef.current = update.interimTranscript;
          setTranscript(update.finalTranscript);
          setInterim(update.interimTranscript);
        },
        onError: (failure) => {
          clearStartTimer();
          if (!alive(sessionId, turnId) || failure === "aborted") return;
          fail(failure === "permission-denied"
            ? "voicePanel.reason.microphonePermissionDenied"
            : "voicePanel.callListenFailed");
        },
        onEnd: () => {
          clearStartTimer();
          if (!alive(sessionId, turnId)) return;
          // Un moteur ne devrait émettre `onend` qu'une fois. Invalider tout de
          // suite ce tour rend néanmoins un callback dupliqué inoffensif et
          // empêche deux messages pour une seule prise de parole.
          const sendTurn = ++turn.current;
          const text = mergeVoiceTranscript(transcriptRef.current, interimRef.current);
          if (!text) {
            fail("voicePanel.callNoSpeech");
            return;
          }
          clearTranscript();
          setPhase("sending");
          const approvalTurn = approvalTurnRef.current;
          approvalTurnRef.current = null;
          if (approvalTurn) {
            const currentApproval = approvalRef.current;
            if (!currentApproval || currentApproval.id !== approvalTurn.id || !onApproval) {
              fail("voicePanel.callApprovalExpired");
              return;
            }
            const labels = new Map<"once" | "deny", string>();
            if (approvalTurn.choices.includes("once")) labels.set("once", t("gateCard.allowOnce"));
            if (approvalTurn.choices.includes("deny")) labels.set("deny", t("gateCard.deny"));
            const normalized = normalizeChoice(text);
            const choice = [...labels].find(([, label]) => normalizeChoice(label) === normalized)?.[0] ?? null;
            if (!choice) {
              fail("voicePanel.callApprovalExact");
              return;
            }
            void Promise.resolve(onApproval(approvalTurn.id, choice)).then(() => {
              if (!alive(sessionId, sendTurn)) return;
              setPhase("working");
            }).catch(() => {
              if (alive(sessionId, sendTurn)) fail("voicePanel.callApprovalFailed");
            });
            return;
          }
          expectedResponseId.current = responsesRef.current.at(-1)?.id ?? null;
          void onSend(text).then((result) => {
            if (!alive(sessionId, sendTurn)) return;
            expectedRunId.current = result.runId;
            setPhase("working");
          }).catch(() => {
            if (alive(sessionId, sendTurn)) fail("voicePanel.callSendFailed");
          });
        },
      }, { continuous: false });
    } catch {
      clearStartTimer();
      if (alive(sessionId, turnId)) fail("voicePanel.callListenFailed");
    }
  };

  const start = async () => {
    if (disabled || starting || activeRef.current || !speech.supported) {
      if (!speech.supported) fail("voicePanel.callUnavailableBrowser");
      return;
    }
    const sessionId = ++session.current;
    activeRef.current = true;
    setActive(true);
    setStarting(true);
    setPhase("idle");
    setErrorKey(null);
    clearTranscript();
    expectedResponseId.current = responsesRef.current.at(-1)?.id ?? null;
    promptedApprovalId.current = null;
    const initialApproval = approvalRef.current;
    if (initialApproval) {
      expectedRunId.current = initialApproval.runId;
      setStarting(false);
      setPhase("approval");
      return;
    }
    expectedRunId.current = null;
    await beginListening(sessionId);
  };

  const hangup = () => {
    activeRef.current = false;
    session.current += 1;
    shutdownMedia();
    setActive(false);
    setStarting(false);
    setPhase("idle");
    setErrorKey(null);
    clearTranscript();
  };

  const resumeAfterSpeech = (
    sessionId: number,
    purpose: { kind: "response" } | { kind: "approval"; approval: VoiceCallApproval } | null,
  ) => {
    if (!alive(sessionId)) return;
    speechPurposeRef.current = null;
    approvalTurnRef.current = purpose?.kind === "approval" ? purpose.approval : null;
    setPhase("idle");
    setStarting(true);
    void beginListening(sessionId);
  };

  const interruptSpeech = () => {
    if (!activeRef.current || phase !== "speaking") return;
    const sessionId = session.current;
    const purpose = speechPurposeRef.current;
    turn.current += 1;
    speech.cancel();
    resumeAfterSpeech(sessionId, purpose);
  };

  const stopAndSend = () => {
    if (!activeRef.current || phase !== "listening") return;
    try {
      recognition.stop();
    } catch {
      fail("voicePanel.callListenFailed");
    }
  };

  useEffect(() => {
    if (!active || (phase !== "working" && phase !== "approval")) return;
    const awaitedRunId = expectedRunId.current;
    const observedRun = awaitedRunId
      ? runs.find((candidate) => candidate.id === awaitedRunId) ?? null
      : null;
    if (observedRun?.status === "failed" || observedRun?.status === "cancelled") {
      fail("voicePanel.callRunFailed");
      return;
    }
    if (approval && approval.runId === awaitedRunId && approval.id !== promptedApprovalId.current) {
      if (!onApproval || approval.choices.length === 0) {
        fail("voicePanel.callApprovalUnavailable");
        return;
      }
      const choices = approval.choices.map((choice) =>
        choice === "once" ? t("gateCard.allowOnce") : t("gateCard.deny"),
      );
      const prompt = t("voicePanel.callApprovalPrompt", {
        action: approval.action,
        choices: choices.map((choice) => `« ${choice} »`).join(" / "),
      });
      promptedApprovalId.current = approval.id;
      const sessionId = session.current;
      turn.current += 1;
      recognition.cancel();
      recognition.dispose();
      const speechTurn = turn.current;
      const purpose = { kind: "approval" as const, approval };
      speechPurposeRef.current = purpose;
      try {
        speech.speak({
          text: prompt,
          lang: locale,
          voiceURI: voiceId ?? readSpeechOutputSettings().voiceURI,
          onStart: () => {
            if (alive(sessionId, speechTurn)) setPhase("speaking");
          },
          onEnd: () => {
            if (alive(sessionId, speechTurn)) resumeAfterSpeech(sessionId, purpose);
          },
          onError: () => {
            if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
          },
        });
      } catch {
        if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
      }
      return;
    }
    if (observedRun && (
      observedRun.status === "queued" ||
      observedRun.status === "pending" ||
      observedRun.status === "starting" ||
      observedRun.status === "running" ||
      observedRun.status === "awaiting_approval"
    )) {
      return;
    }
    // Tant que le run retourné par l'envoi n'est pas encore dans le snapshot,
    // un ancien run (même échoué) n'a aucune autorité sur cette session.
    if (!observedRun) {
      const sessionId = session.current;
      const turnId = turn.current;
      const timeout = window.setTimeout(() => {
        if (alive(sessionId, turnId)) fail("voicePanel.callNoResponse");
      }, RUN_OBSERVATION_GRACE_MS);
      return () => window.clearTimeout(timeout);
    }
    if (observedRun.status !== "completed") return;
    const next = responses.findLast((candidate) => candidate.runId === awaitedRunId) ?? null;
    if (!next || next.id === expectedResponseId.current) {
      // L'API d'envoi peut répondre avant que le snapshot SSE/polling expose
      // le run. On tolère cette fenêtre, mais jamais indéfiniment : sans run ni
      // nouvelle réponse l'appel s'arrête, micro fermé, au lieu de prétendre
      // travailler pour toujours.
      const sessionId = session.current;
      const turnId = turn.current;
      const timeout = window.setTimeout(() => {
        if (alive(sessionId, turnId)) fail("voicePanel.callNoResponse");
      }, RUN_OBSERVATION_GRACE_MS);
      return () => window.clearTimeout(timeout);
    }

    const sessionId = session.current;
    expectedResponseId.current = next.id;
    const remembered = next.text;
    const ask = splitAskUser(remembered);
    const speechSource = ask.prompt
      ? [
          ask.body,
          ask.prompt.question,
          ask.prompt.options.length
            ? t("voicePanel.callAskOptions", { options: ask.prompt.options.join(" ; ") })
            : "",
        ].filter(Boolean).join("\n")
      : remembered;
    const spoken = markdownToSpeechText(speechSource, locale);
    if (!spoken) {
      fail("voicePanel.callNoResponse");
      return;
    }
    // Barrière half-duplex : invalide tout callback micro AVANT de remettre
    // le texte au moteur vocal. Le micro ne peut donc pas transcrire la voix du bot.
    turn.current += 1;
    recognition.cancel();
    recognition.dispose();
    const speechTurn = turn.current;
    const settings = readSpeechOutputSettings();
    const purpose = { kind: "response" as const };
    speechPurposeRef.current = purpose;
    try {
      speech.speak({
        text: spoken,
        lang: locale,
        voiceURI: voiceId ?? settings.voiceURI,
        onStart: () => {
          if (alive(sessionId, speechTurn)) setPhase("speaking");
        },
        onEnd: () => {
          if (!alive(sessionId, speechTurn)) return;
          resumeAfterSpeech(sessionId, purpose);
        },
        onError: () => {
          if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
        },
      });
    } catch {
      if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
    }
  }, [active, approval, locale, onApproval, phase, responses, runs, speech, t, voiceId]);

  useEffect(() => () => {
    activeRef.current = false;
    session.current += 1;
    shutdownMedia();
  }, [recognition, speech]);

  const statusKey: MessageKey = errorKey ?? (
    starting ? "voicePanel.callStatus.starting"
          : phase === "listening" ? "voicePanel.callStatus.listening"
        : phase === "approval" ? "voicePanel.callStatus.approval"
        : phase === "sending" ? "voicePanel.callStatus.sending"
          : phase === "working" ? "voicePanel.callStatus.working"
            : phase === "speaking" ? "voicePanel.callStatus.speaking"
              : "voicePanel.callStatus.idle"
  );
  const supported = speech.supported && recognition.initialObservation().backend?.supported === true;

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="voice-call-title">
        <header className="flex items-start gap-3">
          <span className="rounded-lg bg-muted p-2 text-muted-foreground">
            {phase === "speaking" ? <IconVolume className="size-5" aria-hidden /> : <IconPhone className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="voice-call-title" className="font-medium">{t("voicePanel.callTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">{t(statusKey)}</p>
          </div>
        </header>

        <div className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3" aria-live="polite">
          {transcript || interim ? (
            <p className="whitespace-pre-wrap text-sm">
              {transcript}{transcript && interim ? " " : null}
              {interim ? <span className="text-muted-foreground">{interim}</span> : null}
            </p>
          ) : <p className="text-sm text-muted-foreground">{t("voicePanel.callNoTranscript")}</p>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {!active ? (
            <button
              type="button"
              disabled={disabled || starting || !supported}
              onClick={() => void start()}
              className={BUTTON.primary}
            >
              <IconPhone className="size-4" aria-hidden />
              {t("voicePanel.callStart")}
            </button>
          ) : null}
          {active && phase === "listening" ? (
            <button
              type="button"
              onClick={stopAndSend}
              className={BUTTON.primary}
            >
              <IconSend className="size-4" aria-hidden />
              {t("voicePanel.callSendTurn")}
            </button>
          ) : null}
          {active && phase === "speaking" ? (
            <button
              type="button"
              onClick={interruptSpeech}
              className={BUTTON.primary}
            >
              <IconVolume className="size-4" aria-hidden />
              {t("voicePanel.callStopSpeaking")}
            </button>
          ) : null}
          {active ? (
            <button
              type="button"
              onClick={hangup}
              className={BUTTON.secondary}
            >
              <IconPhoneOff className="size-4" aria-hidden />
              {t("voicePanel.callHangup")}
            </button>
          ) : null}
        </div>
        {!supported ? <p role="alert" className="mt-3 text-sm text-destructive-text">{t("voicePanel.callUnavailableBrowser")}</p> : null}
      </section>
      <SpeechOutputSettings adapter={speech} callAvailable activeVoiceId={voiceId} />
    </div>
  );
}
