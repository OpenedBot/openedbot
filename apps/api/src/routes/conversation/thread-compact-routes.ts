import { Hono } from "hono";
import type { ThreadCompactResult } from "@openedbot/contracts-api";
import { isUuid } from "@openedbot/contracts-primitives";
import { logger } from "@openedbot/platform-observability";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertEntitled } from "@openedbot/identity/domain/entitlement";
import { readRoomCompactionTarget } from "@openedbot/conversation/application/compact-room-request";
import { readIdempotencyKey } from "@openedbot/conversation/application/message-ingress";
import {
  awaitExecutionCommand,
  cancelThreadCompaction,
  commandSettled,
  ExecutionCommandError,
  readThreadCompactionReplay,
  submitThreadCompaction,
  type ExecutionCommandRow,
  type ThreadCompactionCommandResult,
} from "@openedbot/execution/application/execution-commands";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { runtimeLinkLocator, type RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError } from "../../interfaces/http/http-error";
import { requireOperator, type AppVariables } from "../identity/auth";
import { subscriptionPort } from "@openedbot/platform-db/subscription-port";

/**
 * How long the request waits for the worker: the command's own deadline (four
 * one-minute passes) plus its claim. The console gives up at 270 s.
 */
const COMPACT_WAIT_MS = 255_000;

/** The command seams; production uses `@openedbot/execution/application/execution-commands`. */
export type ThreadCompactCommands = {
  replay: typeof readThreadCompactionReplay;
  submit: typeof submitThreadCompaction;
  wait: typeof awaitExecutionCommand;
  cancel: typeof cancelThreadCompaction;
};

export type ThreadCompactRouteDeps = {
  links?: RuntimeLinks;
  locator?: RuntimeLinkLocator;
  commands?: Partial<ThreadCompactCommands>;
  waitMs?: number;
};

/**
 * Compacts a room's history on demand (DEV-332).
 *
 * The route guards (rights, subscription, room, runs, threshold, runtime), then
 * records a durable command the worker executes: the API
 * opens no session on the runtime. It waits for the result in order to return
 * the same response as before; if the client leaves, the summary continues. With
 * `Idempotency-Key`, a replayed request finds the command already
 * recorded and its result instead of opening another.
 */
export function threadCompactRoutes(
  db: Db,
  config: ApiConfig,
  deps: ThreadCompactRouteDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const links = deps.links ?? runtimeLinks();
  const locator = deps.locator ?? runtimeLinkLocator();
  const commands: ThreadCompactCommands = {
    replay: readThreadCompactionReplay,
    submit: submitThreadCompaction,
    wait: awaitExecutionCommand,
    cancel: cancelThreadCompaction,
    ...deps.commands,
  };
  const waitMs = deps.waitMs ?? COMPACT_WAIT_MS;

  routes.post("/:threadId/compact", async (context) => {
    const auth = context.get("auth");
    // Before any database read: a plain member learns nothing about the room.
    requireOperator(auth);
    const threadId = context.req.param("threadId");
    if (!isUuid(threadId)) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    const idempotencyKey = readIdempotencyKey(context.req.header("Idempotency-Key"));

    // A summary costs tokens on the client's runtime, like a run.
    const subscription = await withTenant(db, auth.organizationId, async (tx) => {
      const plan = await subscriptionPort().read(tx, auth.organizationId);
      return plan ? { status: plan.status } : undefined;
    });
    assertEntitled(
      config.billingEnforced,
      subscription,
      "Le résumé est bloqué tant que l’abonnement n’est pas actif.",
    );

    let submitted: { command: ExecutionCommandRow; replayed: boolean } | undefined;
    try {
      // A replay comes before the guards: once its summary is written the
      // thread is below the threshold, and only the recorded command answers.
      const replay = idempotencyKey
        ? await commands.replay(db, { organizationId: auth.organizationId, threadId, userId: auth.userId, idempotencyKey })
        : null;
      if (replay) {
        submitted = { command: replay, replayed: true };
      } else {
        const target = await readRoomCompactionTarget(db, auth.organizationId, threadId);
        if (target.kind !== "ready") {
          // A concurrent request under the same key may have recorded (and
          // finished) the compaction since the replay read: it answers.
          const late = idempotencyKey
            ? await commands.replay(db, { organizationId: auth.organizationId, threadId, userId: auth.userId, idempotencyKey })
            : null;
          if (!late) throw refusal(target.kind);
          submitted = { command: late, replayed: true };
        }
      }
      if (!submitted) {
        const runtime = await readRuntimeSecret(db, config, auth.organizationId, links, locator);
        if (!runtime) {
          throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de résumer l’historique.");
        }
        submitted = await commands.submit(db, {
          organizationId: auth.organizationId,
          threadId,
          runtimeId: runtime.id,
          userId: auth.userId,
          idempotencyKey,
        });
      }
    } catch (error) {
      throw submitError(error);
    }
    if (submitted.replayed) context.header("Idempotency-Replayed", "true");

    const command = commandSettled(submitted.command)
      ? submitted.command
      : await commands.wait(db, auth.organizationId, submitted.command.id, {
        deadlineMs: waitMs,
        signal: context.req.raw.signal,
      });
    if (!command) throw refusal("not_found");
    if (command.status === "succeeded" && command.result) {
      const result = command.result as ThreadCompactionCommandResult;
      const body: ThreadCompactResult = {
        compacted: true,
        summarizedCount: Number(result.summarizedCount),
        compactedThroughSequence: Number(result.compactedThroughSequence),
        compactedAt: String(result.compactedAt),
      };
      return context.json(body);
    }
    throw commandFailure(command, threadId);
  });

  /** Stops the room's summary in progress; the POST waiting for it answers `COMPACTION_CANCELLED`. */
  routes.delete("/:threadId/compact", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const threadId = context.req.param("threadId");
    if (!isUuid(threadId)) throw refusal("not_found");
    const cancelled = await commands.cancel(db, auth.organizationId, threadId);
    if (!cancelled) throw new HttpError(404, "COMPACTION_NOT_FOUND", "Aucun résumé de ce salon n’est en cours.");
    return context.body(null, 204);
  });

  return routes;
}

function submitError(error: unknown): unknown {
  if (!(error instanceof ExecutionCommandError)) return error;
  if (error.code === "IDEMPOTENCY_KEY_REUSED") {
    return new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà servi à résumer un autre salon.");
  }
  return new HttpError(409, "COMPACTION_IN_PROGRESS", "Un résumé de ce salon est déjà en cours.");
}

function refusal(kind: "not_found" | "not_room" | "run_active" | "below_threshold"): HttpError {
  switch (kind) {
    case "not_found": return new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    case "not_room": return new HttpError(404, "THREAD_NOT_ROOM", "Seul l’historique d’un salon se résume à la demande.");
    case "run_active": return new HttpError(409, "RUN_IN_PROGRESS", "Un membre répond encore : attendez la fin du tour pour résumer.");
    case "below_threshold": return new HttpError(422, "COMPACTION_BELOW_THRESHOLD", "L’historique est encore trop court pour être résumé.");
  }
}

/** The answer of a command that did not succeed: its stable code, mapped as the route answered before S3. */
function commandFailure(command: ExecutionCommandRow, threadId: string): HttpError {
  switch (command.errorCode) {
    case "THREAD_NOT_FOUND": return refusal("not_found");
    case "THREAD_NOT_ROOM": return refusal("not_room");
    case "RUN_IN_PROGRESS": return refusal("run_active");
    case "COMPACTION_BELOW_THRESHOLD": return refusal("below_threshold");
    case "RUNTIME_REQUIRED":
      return new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant de résumer l’historique.");
    case "COMMAND_CANCELLED":
      return new HttpError(409, "COMPACTION_CANCELLED", "Le résumé de ce salon a été arrêté.");
    case "COMMAND_NOT_STARTED":
      return new HttpError(
        503,
        "COMPACTION_NOT_STARTED",
        "Le résumé n’a pas pu démarrer : le service d’exécution ne répond pas. Réessayez dans un instant.",
      );
  }
  if (!commandSettled(command)) {
    return new HttpError(
      504,
      "COMPACTION_STILL_RUNNING",
      "Le résumé continue en arrière-plan ; l’historique se mettra à jour une fois terminé.",
    );
  }
  logger.warn(
    { event: "api.thread_compact_failed", threadId, commandId: command.id, code: command.errorCode, attempts: command.attempts },
    "on-demand room compaction produced no summary",
  );
  return new HttpError(
    502,
    "COMPACTION_FAILED",
    "Le résumé n’a pas pu être produit par le runtime. Réessayez dans un instant.",
  );
}
