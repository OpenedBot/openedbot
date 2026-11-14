import type { HermesRunImage } from "@openedbot/hermes";
import type { ProviderRetryState } from "../provider-fallback";
import type { ResolvedRunSelection } from "./provider-recovery";
import type { RunContext } from "./types";

/** What the first creation sent: a fallback resends it, the terminal measures it. */
export type RunCreateArgs = {
  input: string;
  images: HermesRunImage[];
  instructions: string;
  history: Array<{ role: string; content: string }>;
};

/**
 * The state one `executeRun` shares between its steps and the timers that
 * watch it (heartbeat, steer and approval poll, run timeout). Every field is
 * read or written by more than one of them, which is why it is one object
 * passed explicitly rather than variables captured by a closure. Each step
 * says which fields it writes.
 */
export type RunState = {
  /** Aborted by the timers, the external signal and the approval forwarder. */
  readonly controller: AbortController;
  /** The Hermes run being followed: null before its creation and during a fallback creation. */
  hermesRunId: string | null;
  /** The selection the current attempt runs on, set once the model is persisted. */
  selection: ResolvedRunSelection | null;
  retryState: ProviderRetryState;
  createArgs: RunCreateArgs | null;
  /** Tools or an incomplete observation make replaying the original request unsafe. */
  providerFallbackUnsafe: boolean;
  /** A terminal event was persisted, or the run was settled by a reconciliation. */
  terminal: boolean;
  /** A stop was requested (claimed run, lease renewal, external signal or end of stream). */
  cancelRequested: boolean;
  /** Last sign of activity (frame, forwarded approval or steer), read by the idle watchdog. */
  lastFrameAt: number;
  idleTimedOut: boolean;
  runTimedOut: boolean;
  approvalExpired: boolean;
};

export function createRunState(context: Pick<RunContext, "hermesRunId" | "remoteStopState">): RunState {
  return {
    controller: new AbortController(),
    hermesRunId: context.hermesRunId,
    selection: null,
    retryState: { fallbackAttempted: false, extraModelTried: false, fromProvider: null, fallback: null },
    createArgs: null,
    // A resumed worker cannot prove what the remote run did before it attached.
    providerFallbackUnsafe: context.hermesRunId !== null,
    terminal: false,
    cancelRequested: context.remoteStopState === "requested",
    lastFrameAt: Date.now(),
    idleTimedOut: false,
    runTimedOut: false,
    approvalExpired: false,
  };
}
