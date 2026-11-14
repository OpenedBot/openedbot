import type { SQL } from "bun";
import { type HermesClient, HermesClientError } from "@openedbot/hermes";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import { DELTA_FLUSH_MS, HermesEventNormalizer } from "../../domain/hermes-events";
import { advanceHermesWatermark } from "../../sql/run-columns";
import { readNextRunEventSequence } from "../../sql/run-events";
import { reconcileRunSteerEvent } from "../run-steering";
import type { WorkerConfig } from "../worker-config";
import { approvalForwardErrorCode } from "./approval-forwarding";
import { enrichFrameEvents } from "./frame-events";
import { heldLease, resumeAnnouncedReplay, runKey } from "./lease-transitions";
import { persistEvents } from "./persist";
import { pendingSteerOf, reconcileHermesRun, replayUndeliveredRunSteersSafely } from "./reconcile";
import type { RunState } from "./run-state";
import { fallBackAfterRunFailure } from "./stream-fallback";
import {
  MAX_EVENT_REPLAY_ATTEMPTS,
  classifyHermesFrame,
  eventReplayDelayMs,
  isReplayableStreamFailure,
  waitForHermesEventOrFlush,
} from "./stream";
import type { RunContext } from "./types";
import { describe, log, pollWait } from "./util";

/**
 * Streaming: follows the Hermes run `hermesRunId` frame by frame until its
 * stream ends, and persists what it normalizes into. A resumed run in
 * `polling` is reconciled by status, unless an announced replay lets it
 * stream again; an interrupted replay stream is resumed by `?since=`; a
 * provider failure may restart the stream on a fallback run. Returns the id
 * of the run the stream ended on, for the settlement, or null once the run
 * is settled here (reconciled, lease lost, orphan fallback). Writes
 * `state.terminal`, `state.lastFrameAt`, and what the fallback writes.
 */
export async function streamHermesEvents(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  trace: RunTrace,
  hermesRunId: string,
  replayProbe: Promise<boolean>,
  forwardReadyApprovals: () => Promise<void>,
): Promise<string | null> {
  const { controller } = state;
  // Rejeu : un runtime `connector` qui annonce `features.event_replay` tient
  // un journal numéroté (docs/CONNECTOR.md). On lui demande alors TOUJOURS
  // le flux par `?since=` : la numérotation du journal devient la nôtre, et
  // une rupture SSE se rattrape à la séquence exacte avant tout polling.
  // The probe started at the preflight gate; `hermes.replay_awaited` shows
  // whether the stream still had to wait for it.
  const replaySupported = await replayProbe;
  trace.mark("hermes.replay_awaited");
  trace.set("event_replay", replaySupported);
  if (context.externalState === "polling") {
    if (!replaySupported || context.remoteStopState !== null) {
      trace.set("resume_mode", "status_polling");
      await reconcileHermesRun(db, config, context, client, hermesRunId, controller.signal, trace);
      state.terminal = true;
      return null;
    }
    // A known Hermes id can recover its uncommitted journal after a worker
    // restart. Only an announced, freshly gated replay capability permits
    // this transition; the create POST is never repeated.
    if (!await resumeAnnouncedReplay(db, config, context, hermesRunId)) return null;
    context.externalState = "streaming";
    trace.set("resume_mode", "event_replay");
  }
  const normalizer = await openNormalizer(db, context);
  let rawSequence = replaySupported ? context.lastHermesSequence : 0;
  let flushDeadline: number | null = null;
  let replayAttempts = 0;
  let replayGap = false;
  let restartAfterFallback = false;
  /** Set when the run's own provider refused its login: its `run.error` names it. */
  let authRequiredProvider: string | null = null;
  // Un repli remet l'identifiant à null le temps de sa création, puis le
  // confirme ou sort : le flux ne s'ouvre jamais sans identifiant.
  let streamRunId: string;
  while (true) {
    if (state.hermesRunId === null) throw new Error("Flux Hermes sans identifiant de run.");
    streamRunId = state.hermesRunId;
    const eventStreamController = new AbortController();
    const stopEventStream = () => eventStreamController.abort(controller.signal.reason);
    if (controller.signal.aborted) stopEventStream();
    else controller.signal.addEventListener("abort", stopEventStream, { once: true });
    const rawIterator = client.events(
      streamRunId,
      eventStreamController.signal,
      {
        ...(replaySupported ? { since: rawSequence } : {}),
        // Over the relay this is time to first BYTE, not to the head: Bun.serve
        // (the API internal relay) sends a streamed response head with its first
        // body chunk, so it lands with `hermes.first_event`.
        onOpen: () => trace.mark("hermes.stream_open"),
      },
    )[Symbol.asyncIterator]();
    let nextRaw = rawIterator.next();
    let nativeTerminalSeen = false;
    try {
      while (true) {
        const wake = await waitForHermesEventOrFlush(
          nextRaw,
          flushDeadline === null ? null : flushDeadline - Date.now(),
        );
        if (wake.kind === "flush") {
          const buffered = normalizer.flush();
          flushDeadline = null;
          if (buffered.length > 0) {
            await persistEvents(db, config, context, rawSequence, buffered, client, trace);
          }
          continue;
        }
        if (wake.result.done) {
          // A closed relay socket can end cleanly at the HTTP body boundary.
          // Without a native terminal this is still an interrupted replay stream.
          if (replaySupported && !nativeTerminalSeen && !state.terminal && !controller.signal.aborted) {
            throw new HermesClientError("Le flux Hermes s’est fermé avant son événement terminal.", 502,
              "HERMES_STREAM_INTERRUPTED", { requestDelivery: "response_received" });
          }
          break;
        }
        const raw = wake.result.value;
        nextRaw = rawIterator.next();
        state.lastFrameAt = Date.now();
        trace.mark("hermes.first_event");
        if (raw.event === "message.delta") trace.mark("hermes.first_text_delta");
        // Set this before deduplication or persistence: quiet room phases may
        // hide tools, and even an uncommitted tool can already have acted.
        if (raw.event === "tool.started" || raw.event === "tool.completed"
          || (rawSequence === 0 && raw.sequence === undefined && raw.event !== "run.started")
          || (raw.sequence !== undefined && raw.sequence !== rawSequence + 1)) {
          state.providerFallbackUnsafe = true;
        }
        // Un journal sans mémoire du run (`replay-gap`) repart de 1 : la
        // séquence recule, on ne sait plus ce qui manque, le polling tranche.
        const disposition = classifyHermesFrame(raw, {
          replaySupported,
          rawSequence,
          lastPersistedSequence: context.lastHermesSequence,
        });
        if (disposition.action === "gap") {
          replayGap = true;
          break;
        }
        rawSequence = disposition.rawSequence;
        if (disposition.action === "skip") continue;
        nativeTerminalSeen ||= raw.event === "run.completed" || raw.event === "run.failed"
          || raw.event === "run.error" || raw.event === "run.cancelled" || raw.event === "run.interrupted";
        if (raw.event === "run.steered" && typeof raw.accepted === "boolean") {
          await reconcileRunSteerEvent(db, {
            id: context.id,
            organizationId: context.organizationId,
          }, raw.accepted);
        }
        // Le texte amont d'un échec quitte le fil (voir `hermesRunFailure`) :
        // le journal du worker devient le seul endroit où le lire.
        if (raw.event === "run.failed" || raw.event === "run.error") {
          log("worker.hermes_run_failure_upstream", {
            runId: context.id,
            organizationId: context.organizationId,
            upstream: describe(raw.message ?? raw.error ?? null),
          });
          const createArgs = state.createArgs;
          const selection = state.selection;
          if (createArgs && selection && !controller.signal.aborted) {
            // Text the failed attempt already streamed is persisted first, so
            // the fallback notice is numbered after it and nothing is
            // reordered or merged into the next attempt's answer.
            const pending = normalizer.flush();
            flushDeadline = null;
            // Its watermark stops before the failure frame, still unhandled.
            if (pending.length > 0) await persistEvents(db, config, context, Math.max(0, rawSequence - 1), pending, client, trace);
            const fallback = await fallBackAfterRunFailure(
              db, config, context, client, state, normalizer, raw, { selection, createArgs },
            );
            if (fallback.kind === "auth_required") authRequiredProvider = fallback.provider;
            if (fallback.kind === "settled") return null;
            if (fallback.kind === "restarted") {
              rawSequence = 0;
              replayAttempts = 0;
              replayGap = false;
              restartAfterFallback = true;
              break;
            }
          }
        }
        const events = await enrichFrameEvents(context, client, normalizer, raw, normalizer.push(raw), {
          authRequiredProvider,
          createArgs: state.createArgs,
        });
        if (normalizer.hasBufferedDelta) flushDeadline ??= Date.now() + DELTA_FLUSH_MS;
        else flushDeadline = null;
        if (events.length > 0) {
          state.terminal = state.terminal || events.some((event) => event.type === "run.completed" || event.type === "run.error");
          await persistEvents(db, config, context, rawSequence, events, client, trace);
          if (events.some((event) => event.type === "approval.requested")) {
            void forwardReadyApprovals().catch((error) => {
              log("worker.approval_forward_failed", {
                runId: context.id,
                errorCode: approvalForwardErrorCode(error),
              });
            });
          }
          // Les steers que l'agent n'a jamais lus reviennent sur le terminal :
          // ils redeviennent des tours, une fois ce run réglé.
          if (raw.event === "run.completed") {
            await replayUndeliveredRunSteersSafely(db, context, pendingSteerOf(raw.pending_steer));
          }
        } else if (!normalizer.hasBufferedDelta) {
          // Un delta tamponné n'est pas encore durable. Avancer son watermark
          // séparément obligerait une écriture PostgreSQL par fragment et,
          // après crash, ferait sauter du texte jamais persisté. Le flush
          // groupe texte et watermark dans la même transaction.
          await advanceHermesWatermark(db, runKey(context), heldLease(config, context), rawSequence);
        }
      }
    } catch (error) {
      if (
        replaySupported && !replayGap && replayAttempts < MAX_EVENT_REPLAY_ATTEMPTS &&
        !controller.signal.aborted && isReplayableStreamFailure(error)
      ) {
        replayAttempts += 1;
        log("worker.hermes_stream_replay", {
          runId: context.id,
          organizationId: context.organizationId,
          attempt: replayAttempts,
          since: rawSequence,
          code: error.code,
        });
        await pollWait(eventReplayDelayMs(replayAttempts), controller.signal);
        continue;
      }
      throw error;
    } finally {
      // `for await` faisait cette fermeture implicitement. Le loop temporel
      // est manuel : sur erreur DB/annulation il doit rendre le reader SSE,
      // sinon une lecture `next()` peut rester vivante hors du run.
      eventStreamController.abort("stream_consumer_closed");
      controller.signal.removeEventListener("abort", stopEventStream);
      await rawIterator.return?.(undefined).catch(() => undefined);
    }
    if (restartAfterFallback) {
      restartAfterFallback = false;
      continue;
    }
    break;
  }
  if (replayGap) {
    log("worker.hermes_stream_replay_gap", { runId: context.id, organizationId: context.organizationId, since: rawSequence });
  }
  const tail = normalizer.flush();
  if (tail.length > 0) await persistEvents(db, config, context, rawSequence, tail, client, trace);
  return streamRunId;
}

/**
 * The normalizer of a run's stream, from the run's next event sequence (a
 * proposal: every write checks it again under the run's locks). Un worker
 * repris doit restaurer les identifiants publiés et le FIFO des appels
 * encore ouverts.
 */
async function openNormalizer(db: SQL, context: Pick<RunContext, "organizationId" | "id">): Promise<HermesEventNormalizer> {
  const nextSequence = await readNextRunEventSequence(db, context.organizationId, context.id);
  const priorToolRows = nextSequence > 0
    ? await db<Array<{ tool: string; toolCallId: string; unfinished: boolean }>>`
        select call_row.payload->>'tool' as tool, call_row.payload->>'toolCallId' as "toolCallId",
          not exists (
            select 1 from run_events result_row
             where result_row.organization_id = call_row.organization_id and result_row.run_id = call_row.run_id
               and result_row.type = 'tool.result'
               and result_row.payload->>'toolCallId' = call_row.payload->>'toolCallId'
          ) as unfinished
         from run_events call_row
        where call_row.organization_id = ${context.organizationId} and call_row.run_id = ${context.id}
          and call_row.type = 'tool.call' and call_row.payload->>'tool' is not null
          and call_row.payload->>'toolCallId' is not null
        order by call_row.sequence asc
      `
    : [];
  return new HermesEventNormalizer(nextSequence, {
    flushFirstDelta: true,
    priorToolCalls: priorToolRows.map((call) => ({
      tool: call.tool,
      toolCallId: call.toolCallId,
      completed: !call.unfinished,
    })),
  });
}
