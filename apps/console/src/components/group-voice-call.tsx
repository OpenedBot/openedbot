import { useEffect, useMemo, useRef, useState } from "react";
import { IconPhone, IconPhoneOff, IconSend, IconUsers, IconVolume } from "@tabler/icons-react";
import type { ProductRunStatus, WorkflowStatus } from "@openedbot/contracts-api";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { useT, type MessageKey } from "../lib/i18n";
import { normalizeChoice } from "../lib/format";
import { markdownToSpeechText } from "../lib/voice/speech-text";
import {
  createBrowserVoiceRecognitionAdapter,
  mergeVoiceTranscript,
  type VoiceRecognitionAdapter,
} from "../lib/voice/web-voice-recognition";
import {
  createBrowserSpeechSynthesisAdapter,
  readSpeechOutputSettings,
  type SpeechSynthesisAdapter,
} from "../lib/voice/web-speech-synthesis";
import { SpeechOutputSettings } from "./speech-output-settings";
import { BUTTON } from "./settings/primitives";

export type GroupVoiceResponse = {
  id: string;
  runId: string | null;
  authorBotId: string | null;
  text: string;
};

export type GroupVoiceRun = {
  id: string;
  workflowId?: string | null;
  botId?: string | null;
  status: ProductRunStatus;
  completionKind?: string | null;
};

export type GroupVoiceWorkflow = {
  id: string;
  status: WorkflowStatus;
  usedSteps?: number;
  maxSteps?: number;
};

export type GroupVoiceApproval = {
  id: string;
  runId: string;
  action: string;
  choices: readonly ("once" | "deny")[];
};

type Phase = "idle" | "approval" | "listening" | "sending" | "working" | "speaking" | "error";
const OBSERVATION_TIMEOUT_MS = 30_000;
const LISTEN_START_TIMEOUT_MS = 30_000;

const isSilentPass = (value: string) => /^\(?pass\)?[.!?…]*$/i.test(value.trim());

export function GroupVoiceCall({
  responses,
  runs,
  workflows,
  roomRunning,
  approval = null,
  voiceByBotId,
  disabled = false,
  onSend,
  onApproval,
  onActiveChange,
  recognitionAdapter: injectedRecognition,
  speechAdapter: injectedSpeech,
}: {
  responses: readonly GroupVoiceResponse[];
  runs: readonly GroupVoiceRun[];
  workflows: readonly GroupVoiceWorkflow[];
  roomRunning: boolean;
  approval?: GroupVoiceApproval | null;
  voiceByBotId: ReadonlyMap<string, string | null>;
  disabled?: boolean;
  onSend: (transcript: string) => Promise<{ runId: string; workflowId: string | null }>;
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
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [starting, setStarting] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null);
  const [activeSpeechVoiceId, setActiveSpeechVoiceId] = useState<string | null>(null);
  const session = useRef(0);
  const turn = useRef(0);
  const activeRef = useRef(false);
  const transcriptRef = useRef("");
  const interimRef = useRef("");
  const responsesRef = useRef(responses);
  const runsRef = useRef(runs);
  const approvalRef = useRef(approval);
  const approvalTurnRef = useRef<GroupVoiceApproval | null>(null);
  const promptedApprovalId = useRef<string | null>(null);
  const expectedWorkflowId = useRef<string | null>(null);
  const baselineResponseIds = useRef(new Set<string>());
  const workflowResponseCount = useRef(0);
  const sessionVoices = useRef(new Map<string, string | null>());
  const queue = useRef<GroupVoiceResponse[]>([]);
  const speechPurpose = useRef<"queue" | { approval: GroupVoiceApproval } | null>(null);
  const pendingTimers = useRef(new Set<number>());

  useEffect(() => { responsesRef.current = responses; }, [responses]);
  useEffect(() => { runsRef.current = runs; }, [runs]);
  useEffect(() => { approvalRef.current = approval; }, [approval]);
  useEffect(() => {
    onActiveChange?.(active);
    return () => {
      if (active) onActiveChange?.(false);
    };
  }, [active, onActiveChange]);

  const alive = (sessionId: number, turnId?: number) =>
    activeRef.current && session.current === sessionId
    && (turnId === undefined || turn.current === turnId);

  const clearTranscript = () => {
    transcriptRef.current = "";
    interimRef.current = "";
    setTranscript("");
    setInterim("");
  };

  const clearTimer = (timer: number | undefined) => {
    if (timer === undefined || timer === 0) return;
    window.clearTimeout(timer);
    pendingTimers.current.delete(timer);
  };

  const shutdown = () => {
    turn.current += 1;
    approvalTurnRef.current = null;
    speechPurpose.current = null;
    queue.current = [];
    setActiveSpeechVoiceId(null);
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
    shutdown();
  };

  const beginListening = async (sessionId: number) => {
    let timer: number | undefined;
    let observation;
    try {
      observation = await Promise.race([
        recognition.refreshObservation(),
        new Promise<null>((resolve) => {
          timer = window.setTimeout(() => resolve(null), OBSERVATION_TIMEOUT_MS);
          pendingTimers.current.add(timer);
        }),
      ]);
    } catch {
      clearTimer(timer);
      if (alive(sessionId)) fail("voicePanel.callListenFailed");
      return;
    }
    clearTimer(timer);
    if (!alive(sessionId)) return;
    if (!observation) {
      fail("voicePanel.callListenFailed");
      return;
    }
    if (!observation?.backend?.supported || !observation.microphone?.available) {
      fail(observation?.microphone && !observation.microphone.available
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
          const sendTurn = ++turn.current;
          const text = mergeVoiceTranscript(transcriptRef.current, interimRef.current);
          if (!text) {
            fail("voicePanel.callNoSpeech");
            return;
          }
          clearTranscript();
          setPhase("sending");
          const pendingApproval = approvalTurnRef.current;
          approvalTurnRef.current = null;
          if (pendingApproval) {
            const current = approvalRef.current;
            if (!current || current.id !== pendingApproval.id || !onApproval) {
              fail("voicePanel.callApprovalExpired");
              return;
            }
            const choices = new Map<"once" | "deny", string>();
            if (pendingApproval.choices.includes("once")) choices.set("once", t("gateCard.allowOnce"));
            if (pendingApproval.choices.includes("deny")) choices.set("deny", t("gateCard.deny"));
            const choice = [...choices].find(([, label]) => normalizeChoice(label) === normalizeChoice(text))?.[0] ?? null;
            if (!choice) {
              fail("voicePanel.callApprovalExact");
              return;
            }
            void Promise.resolve(onApproval(pendingApproval.id, choice)).then(() => {
              if (alive(sessionId, sendTurn)) setPhase("working");
            }).catch(() => {
              if (alive(sessionId, sendTurn)) fail("voicePanel.callApprovalFailed");
            });
            return;
          }
          void onSend(text).then((result) => {
            if (!alive(sessionId, sendTurn)) return;
            expectedWorkflowId.current = result.workflowId;
            workflowResponseCount.current = 0;
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

  const resumeListening = (sessionId: number, approvalTurn: GroupVoiceApproval | null = null) => {
    if (!alive(sessionId)) return;
    speechPurpose.current = null;
    approvalTurnRef.current = approvalTurn;
    setActiveSpeechVoiceId(null);
    setPhase("idle");
    setStarting(true);
    void beginListening(sessionId);
  };

  /**
   * Ajoute exactement une fois les bulles persistées du workflow attendu.
   * L'ordre du snapshot est l'ordre de `messages.sequence` fourni par l'API.
   * Les notices de plafond et les `(pass)` ne sont jamais transformés en voix.
   */
  const collectWorkflowResponses = (workflowId: string): boolean => {
    const workflowRuns = runsRef.current.filter((run) => run.workflowId === workflowId);
    if (workflowRuns.length > ROOM_LIMITS.maxMemberTurns) {
      fail("voicePanel.groupCallCapExceeded");
      return false;
    }
    const runIds = new Set(workflowRuns.map((run) => run.id));
    const fresh = responsesRef.current.filter((response) =>
      !baselineResponseIds.current.has(response.id)
      && response.runId !== null
      && runIds.has(response.runId),
    );
    if (workflowResponseCount.current + fresh.length > ROOM_LIMITS.maxMessagesPerSend) {
      fail("voicePanel.groupCallCapExceeded");
      return false;
    }
    workflowResponseCount.current += fresh.length;
    for (const response of fresh) {
      baselineResponseIds.current.add(response.id);
      const visible = response.text;
      if (visible.trim() && !isSilentPass(visible)) queue.current.push(response);
    }
    return true;
  };

  const speakNext = (sessionId: number) => {
    if (!alive(sessionId)) return;
    const workflowId = expectedWorkflowId.current;
    if (workflowId && !collectWorkflowResponses(workflowId)) return;
    const next = queue.current.shift() ?? null;
    if (!next) {
      expectedWorkflowId.current = null;
      resumeListening(sessionId);
      return;
    }
    const remembered = next.text;
    if (!remembered.trim() || isSilentPass(remembered)) {
      speakNext(sessionId);
      return;
    }
    const ask = splitAskUser(remembered);
    const source = ask.prompt
      ? [
          ask.body,
          ask.prompt.question,
          ask.prompt.options.length
            ? t("voicePanel.callAskOptions", { options: ask.prompt.options.join(" ; ") })
            : "",
        ].filter(Boolean).join("\n")
      : remembered;
    const text = markdownToSpeechText(source, locale);
    if (!text) {
      speakNext(sessionId);
      return;
    }
    const speechTurn = ++turn.current;
    speechPurpose.current = "queue";
    const voiceURI = next.authorBotId
      ? sessionVoices.current.get(next.authorBotId) ?? readSpeechOutputSettings().voiceURI
      : readSpeechOutputSettings().voiceURI;
    setActiveSpeechVoiceId(voiceURI);
    try {
      speech.speak({
        text,
        lang: locale,
        voiceURI,
        onStart: () => {
          if (alive(sessionId, speechTurn)) setPhase("speaking");
        },
        onEnd: () => {
          if (alive(sessionId, speechTurn)) speakNext(sessionId);
        },
        onError: () => {
          if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
        },
      });
    } catch {
      if (alive(sessionId, speechTurn)) fail("voicePanel.callSpeechFailed");
    }
  };

  const start = async () => {
    if (disabled || starting || activeRef.current || !speech.supported) return;
    const sessionId = ++session.current;
    activeRef.current = true;
    setActive(true);
    setStarting(true);
    setPhase("idle");
    setErrorKey(null);
    clearTranscript();
    baselineResponseIds.current = new Set(responses.map((response) => response.id));
    workflowResponseCount.current = 0;
    sessionVoices.current = new Map(voiceByBotId);
    promptedApprovalId.current = null;
    const initialApproval = approvalRef.current;
    if (initialApproval) {
      expectedWorkflowId.current = runs.find((run) => run.id === initialApproval.runId)?.workflowId ?? null;
      if (!expectedWorkflowId.current) {
        fail("voicePanel.callApprovalUnavailable");
        return;
      }
      setStarting(false);
      setPhase("approval");
      return;
    }
    expectedWorkflowId.current = null;
    await beginListening(sessionId);
  };

  const hangup = () => {
    activeRef.current = false;
    session.current += 1;
    shutdown();
    setActive(false);
    setStarting(false);
    setPhase("idle");
    setErrorKey(null);
    clearTranscript();
  };

  const stopAndSend = () => {
    if (!activeRef.current || phase !== "listening") return;
    try { recognition.stop(); } catch { fail("voicePanel.callListenFailed"); }
  };

  const interruptSpeech = () => {
    if (!activeRef.current || phase !== "speaking") return;
    const sessionId = session.current;
    turn.current += 1;
    queue.current = [];
    speech.cancel();
    resumeListening(sessionId);
  };

  useEffect(() => {
    if (!active || (phase !== "working" && phase !== "approval" && phase !== "speaking")) return;
    const workflowId = expectedWorkflowId.current;
    const runForApproval = approval
      ? runs.find((run) => run.id === approval.runId) ?? null
      : null;
    if (approval && runForApproval?.workflowId === workflowId && approval.id !== promptedApprovalId.current) {
      if (!onApproval || approval.choices.length === 0) {
        fail("voicePanel.callApprovalUnavailable");
        return;
      }
      promptedApprovalId.current = approval.id;
      const sessionId = session.current;
      const speechTurn = ++turn.current;
      recognition.cancel();
      recognition.dispose();
      // Une gate a priorité sur toute lecture devenue obsolète. L'annulation
      // explicite rend aussi les adaptateurs injectés sûrs : `speak()` ne doit
      // pas être supposé annuler son prédécesseur.
      queue.current = [];
      speech.cancel();
      const labels = approval.choices.map((choice) =>
        choice === "once" ? t("gateCard.allowOnce") : t("gateCard.deny"),
      );
      const purpose = { approval };
      speechPurpose.current = purpose;
      const approvalVoiceId = runForApproval?.botId
        ? sessionVoices.current.get(runForApproval.botId) ?? readSpeechOutputSettings().voiceURI
        : readSpeechOutputSettings().voiceURI;
      setActiveSpeechVoiceId(approvalVoiceId);
      try {
        speech.speak({
          text: t("voicePanel.callApprovalPrompt", {
            action: approval.action,
            choices: labels.map((label) => `« ${label} »`).join(" / "),
          }),
          lang: locale,
          voiceURI: approvalVoiceId,
          onStart: () => {
            if (alive(sessionId, speechTurn)) setPhase("speaking");
          },
          onEnd: () => {
            if (alive(sessionId, speechTurn)) resumeListening(sessionId, approval);
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
    // Une bulle peut atteindre le snapshot pendant que la précédente est
    // encore lue. Elle rejoint la même file ; elle ne peut jamais rouvrir le
    // micro entre deux membres.
    if (phase === "speaking") {
      if (workflowId && speechPurpose.current === "queue") collectWorkflowResponses(workflowId);
      return;
    }
    // `setActiveSpeechVoiceId` peut rendre avant le callback natif `onstart`.
    // La requête TTS déjà remise à l'adaptateur reste l'unique propriétaire de
    // la file ; ne jamais lancer le membre suivant sur ce rendu intermédiaire.
    if (phase === "working" && speechPurpose.current === "queue") return;
    if (!workflowId) {
      fail("voicePanel.callNoResponse");
      return;
    }
    const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? null;
    if (!workflow) {
      const sessionId = session.current;
      const turnId = turn.current;
      const timer = window.setTimeout(() => {
        if (alive(sessionId, turnId)) fail("voicePanel.callNoResponse");
      }, OBSERVATION_TIMEOUT_MS);
      return () => window.clearTimeout(timer);
    }
    if (workflow.status === "failed" || workflow.status === "cancelled" || workflow.status === "expired") {
      fail("voicePanel.callRunFailed");
      return;
    }
    if (workflow.status === "unknown") {
      fail("voicePanel.callRunFailed");
      return;
    }
    if (workflow.status !== "completed") return;
    if ((workflow.usedSteps ?? 0) > ROOM_LIMITS.maxMemberTurns
      || (workflow.maxSteps ?? ROOM_LIMITS.maxMemberTurns) > ROOM_LIMITS.maxMemberTurns) {
      fail("voicePanel.groupCallCapExceeded");
      return;
    }
    // `group.running` couvre les trous entre runs tant que le workflow est
    // actif. Une fois CE workflow terminal, son statut et ses messages
    // persistés priment : une autre entrée FIFO ne doit pas bloquer cet appel.
    if (!collectWorkflowResponses(workflowId)) return;
    if (!queue.current.length) {
      // Un salon entièrement silencieux est un résultat normal (`pass`) : pas
      // de bulle inventée, et le prochain tour opérateur peut commencer.
      expectedWorkflowId.current = null;
      resumeListening(session.current);
      return;
    }
    // Barrière de toute la file : aucun tour micro entre deux membres.
    turn.current += 1;
    recognition.cancel();
    recognition.dispose();
    speakNext(session.current);
  }, [active, approval, locale, onApproval, phase, responses, roomRunning, runs, speech, t, workflows]);

  useEffect(() => () => {
    activeRef.current = false;
    session.current += 1;
    shutdown();
  }, [recognition, speech]);

  const statusKey: MessageKey = errorKey ?? (
    starting ? "voicePanel.callStatus.starting"
      : phase === "approval" ? "voicePanel.callStatus.approval"
        : phase === "listening" ? "voicePanel.callStatus.listening"
          : phase === "sending" ? "voicePanel.callStatus.sending"
            : phase === "working" ? "voicePanel.groupCallWorking"
              : phase === "speaking" ? "voicePanel.groupCallSpeaking"
                : "voicePanel.callStatus.idle"
  );
  const supported = speech.supported && recognition.initialObservation().backend?.supported === true;

  return (
    <div className="space-y-3">
      <section
        className="rounded-xl border border-border bg-card p-4"
        aria-labelledby="group-voice-call-title"
        aria-busy={active && (roomRunning || phase === "sending" || phase === "working")}
      >
        <header className="flex items-start gap-3">
          <span className="rounded-lg bg-muted p-2 text-muted-foreground">
            {phase === "speaking" ? <IconVolume className="size-5" aria-hidden /> : <IconUsers className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="group-voice-call-title" className="font-medium">{t("voicePanel.groupCallTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">{t(statusKey)}</p>
          </div>
        </header>
        <div className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3" aria-live="polite">
          {transcript || interim ? (
            <p className="whitespace-pre-wrap text-sm">{transcript}{transcript && interim ? " " : null}<span className="text-muted-foreground">{interim}</span></p>
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
          {active && phase === "speaking" && speechPurpose.current === "queue" ? (
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
            <button type="button" onClick={hangup} className={BUTTON.secondary}>
              <IconPhoneOff className="size-4" aria-hidden />
              {t("voicePanel.callHangup")}
            </button>
          ) : null}
        </div>
        {!supported ? <p role="alert" className="mt-3 text-sm text-destructive-text">{t("voicePanel.callUnavailableBrowser")}</p> : null}
      </section>
      <SpeechOutputSettings adapter={speech} callAvailable activeVoiceId={activeSpeechVoiceId} />
    </div>
  );
}
