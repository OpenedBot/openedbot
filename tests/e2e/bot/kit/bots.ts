/**
 * Disposable bots and their turns. Every bot created here is registered and
 * purged before the run ends, whatever fails; a purge only counts once the
 * durable host cleanup has SUCCEEDED (it proves the bot's sessions and
 * profile are gone from the runtime, re-checking sessions Hermes re-creates).
 */
import type { SQL } from "bun";
import type { BotDto, BotPurgeResultDto } from "@openedbot/contracts-api";
import { hasNonEmptyAssistantText } from "../../../../scripts/lib/fast-path-measurements";
import type { E2eConfig } from "./config";
import type { EventStream, RunMarks } from "./events";
import type { ModelChoice, Session } from "./session";

export type CreateBotInput = {
  name: string;
  description?: string;
  mission?: string;
  instructions?: string;
  greet?: boolean;
  locale?: "fr" | "en";
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Absent: the organization's default (D-1, `auto` once the review is proven). */
  permissionMode?: "manual" | "plan" | "auto" | "bypass";
};

export type RunRow = {
  id: string;
  status: string;
  origin: string | null;
  output: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  executionSessionKey: string | null;
};

export type Turn = {
  runId: string;
  t0: number;
  acceptedMs: number;
  marks: RunMarks | null;
  run: RunRow | null;
};

/** The run.error code and message of a failed turn, for the report (never model output). */
export function turnFailure(turn: Pick<Turn, "marks"> | null): string {
  const payload = turn?.marks?.terminalPayload as { errorCode?: unknown; message?: unknown } | undefined;
  if (!turn?.marks) return "no terminal event";
  if (turn.marks.terminalType !== "run.error") return String(turn.marks.terminalType);
  return `run.error ${String(payload?.errorCode ?? "")}: ${String(payload?.message ?? "").slice(0, 240)}`;
}

export type PurgeOutcome = {
  botId: string;
  name: string;
  deleteMs: number;
  cleanup: "succeeded" | "failed" | "timeout" | "none" | `http_${number}`;
  verifyPasses: number | null;
  durationMs: number;
};

export class BotLab {
  private readonly live = new Map<string, BotDto>();
  readonly purges: PurgeOutcome[] = [];
  /** A short tag so two concurrent runs never collide on names. */
  readonly tag = crypto.randomUUID().slice(0, 6);

  constructor(
    readonly session: Session,
    readonly db: SQL,
    readonly events: EventStream,
    readonly config: E2eConfig,
  ) {}

  async create(input: CreateBotInput): Promise<BotDto> {
    // Like the console sheet: one request id per creation, so the API may
    // answer a retry with the same bot (200) instead of creating a twin.
    const bot = await this.session.api<BotDto>("POST", "/api/bots", {
      ...input,
      name: `${input.name} ${this.tag}`,
      clientRequestId: crypto.randomUUID(),
    }, 201);
    this.live.set(bot.id, bot);
    return bot;
  }

  /**
   * The API refuses a model change while the profile is still cloning
   * (409 BOT_PROFILE_PREPARING), so this waits for the clone like an
   * operator retrying would.
   */
  async setModel(bot: BotDto, choice: ModelChoice): Promise<BotDto> {
    await this.waitProvision(bot.id);
    const patched = await this.session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, {
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
    });
    if (patched.model !== choice.model) throw new Error(`The bot model reads back as ${String(patched.model)}, not ${choice.model}.`);
    return patched;
  }

  async greetingRunId(botId: string, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.db<{ id: string }[]>`select id from runs where bot_id = ${botId} and origin = 'bot_greeting' limit 1`;
      if (rows[0]) return rows[0].id;
      await Bun.sleep(50);
    }
    throw new Error("No bot_greeting run was queued for a bot created with greet.");
  }

  async run(runId: string): Promise<RunRow | null> {
    const rows = await this.db<RunRow[]>`
      select id, status, origin, output, created_at as "createdAt", started_at as "startedAt",
             ended_at as "endedAt", execution_session_key as "executionSessionKey"
        from runs where id = ${runId}`;
    return rows[0] ?? null;
  }

  /** Waits for the profile clone to settle; `null` when the bot has no provision. */
  async waitProvision(botId: string, timeoutMs = this.config.cleanupTimeoutMs): Promise<{ status: string | null; finishedAt: Date | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.db<{ status: string; finishedAt: Date | null }[]>`
        select status, finished_at as "finishedAt" from bot_profile_provisions where bot_id = ${botId}`;
      const row = rows[0];
      if (!row || ["succeeded", "failed", "cancelled"].includes(row.status)) return { status: row?.status ?? null, finishedAt: row?.finishedAt ?? null };
      await Bun.sleep(250);
    }
    return { status: "timeout", finishedAt: null };
  }

  /** Sends one operator message and follows its run to the end. */
  async send(threadId: string, input: string): Promise<Turn> {
    const t0 = Date.now();
    const { runId } = await this.session.api<{ runId: string }>("POST", `/api/threads/${threadId}/messages`, { input }, 202);
    const acceptedMs = Date.now() - t0;
    const marks = await this.events.waitTerminal(runId, this.config.runTimeoutMs);
    return { runId, t0, acceptedMs, marks, run: await this.run(runId) };
  }

  async follow(runId: string, t0: number): Promise<Turn> {
    const marks = await this.events.waitTerminal(runId, this.config.runTimeoutMs);
    return { runId, t0, acceptedMs: 0, marks, run: await this.run(runId) };
  }

  /** A turn that ended `completed` with a non-empty assistant message in the thread. */
  async answered(threadId: string, runId: string): Promise<boolean> {
    const thread = await this.session.api<{ messages: Array<{ role: string; runId: string | null; content: unknown }> }>("GET", `/api/threads/${threadId}`);
    return thread.messages.some((message) => message.role === "assistant" && message.runId === runId && hasNonEmptyAssistantText(message.content));
  }

  /** Leaves the bot alive on purpose (`--keep`): the report names it. */
  release(botId: string): void {
    this.live.delete(botId);
  }

  async purge(botId: string, options: { waitProvision?: boolean } = {}): Promise<PurgeOutcome> {
    const started = Date.now();
    const name = this.live.get(botId)?.name ?? botId;
    if (options.waitProvision !== false) await this.waitProvision(botId);
    const deleteStarted = Date.now();
    let response = await this.session.raw("DELETE", `/api/bots/${botId}?purge=1`);
    const deleteMs = Date.now() - deleteStarted;
    if (!response.ok) response = await this.session.raw("DELETE", `/api/bots/${botId}?purge=1&force=1`);
    let cleanup: PurgeOutcome["cleanup"] = `http_${response.status}`;
    let verifyPasses: number | null = null;
    if (response.ok) {
      const result = (await response.json()) as BotPurgeResultDto;
      const waited = await this.waitCleanup(botId);
      cleanup = waited.status === "none" && result.hostCleanup === "none" ? "none" : waited.status;
      verifyPasses = waited.verifyPasses;
      this.live.delete(botId);
    }
    const outcome: PurgeOutcome = { botId, name, deleteMs, cleanup, verifyPasses, durationMs: Date.now() - started };
    this.purges.push(outcome);
    return outcome;
  }

  private async waitCleanup(botId: string): Promise<{ status: "succeeded" | "failed" | "timeout" | "none"; verifyPasses: number | null }> {
    const deadline = Date.now() + this.config.cleanupTimeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.db<{ status: string; verifyPasses: number }[]>`
        select status, verify_passes as "verifyPasses" from bot_host_cleanups
         where bot_id = ${botId} order by created_at desc limit 1`;
      const row = rows[0];
      if (!row) return { status: "none", verifyPasses: null };
      if (row.status === "succeeded" || row.status === "failed") return { status: row.status, verifyPasses: row.verifyPasses };
      await Bun.sleep(500);
    }
    return { status: "timeout", verifyPasses: null };
  }

  /** Purges every bot still registered, in parallel; never throws. */
  async purgeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((botId) =>
      this.purge(botId).catch((error: unknown) => {
        this.purges.push({ botId, name: botId, deleteMs: 0, cleanup: "http_0", verifyPasses: null, durationMs: 0 });
        console.error(JSON.stringify({ event: "e2e.purge_error", botId, message: error instanceof Error ? error.message : String(error) }));
      })));
  }
}
