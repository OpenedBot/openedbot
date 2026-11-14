import { useState, type ReactNode } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  canOperateWorkspace,
  ROOM_COMPACT_MIN_CHARS,
  type BotDto,
  type BotFaceSpec,
  type RunDto,
  type ThreadCompactionDto,
  type ThreadMessageDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { Button, Dialog, toast } from "@openedbot/browser-ui-kit";
import { api, ApiError, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
import { modelUnavailableByBot, type ModelUnavailableState } from "../lib/run/model-unavailable";
import { BotFace } from "./bot-face";
import {
  botContextReading,
  modelContextQueryOptions,
  nonEmpty,
  type BotContextReading,
} from "./thread-context-tab";

/**
 * A crew's context chip, and the list of its members.
 *
 * A crew does not have ONE gauge: each member runs in its own Hermes
 * session, with its model and its window. The chip therefore shows the member
 * closest to its limit (the one that will break first), and the dialog
 * gives each member, model included. Same rule as `ThreadContextTab`: one
 * shows only what has been measured, and with no known window it is the tokens
 * that are written, with no percentage.
 */

export type GroupContextMember = { id: string; name: string; face: BotFaceSpec | null };

/** What a member's row knows about them, already resolved by `GroupContextTab`. */
export type GroupMemberContext = {
  member: GroupContextMember;
  /** The bot's configured model, otherwise the one the host gives for its profile. */
  configuredModel: string | null;
  /** `null`: no completed turn has returned usage for this member. */
  reading: BotContextReading | null;
  /**
   * The provider refuses this member's model (its last completed turn is
   * that failure): the alert stays until a successful turn.
   */
  modelUnavailable?: ModelUnavailableState | null;
};

/**
 * The member closest to its limit: the highest percentage, then,
 * between two unknown windows, the most tokens. A known percentage
 * beats a raw count, which compares to nothing. `null` if no one
 * has a measurement.
 */
export function busiestMember(members: readonly GroupMemberContext[]): (GroupMemberContext & { reading: BotContextReading }) | null {
  let best: (GroupMemberContext & { reading: BotContextReading }) | null = null;
  for (const entry of members) {
    if (!entry.reading) continue;
    const candidate = entry as GroupMemberContext & { reading: BotContextReading };
    if (!best) {
      best = candidate;
      continue;
    }
    const a = candidate.reading;
    const b = best.reading;
    const better = a.percent !== null && b.percent !== null
      ? a.percent > b.percent
      : (a.percent !== null) !== (b.percent !== null)
        ? a.percent !== null
        : a.used > b.used;
    if (better) best = candidate;
  }
  return best;
}

/**
 * The model of a last turn that is not the one configured on the bot: the
 * provider switched to a fallback. With no known configured model, one cannot
 * say there is a fallback.
 */
export function isFallbackModel(reading: BotContextReading | null, configuredModel: string | null): boolean {
  const ran = nonEmpty(reading?.model);
  const configured = nonEmpty(configuredModel);
  return ran !== null && configured !== null && ran !== configured;
}

/**
 * A row of the dialog. `status` (under the model) and `actions` (on the right, next
 * to « Changer le modèle ») are slots: the « modèle
 * indisponible » state and the compression button lodge there without touching the
 * row.
 */
export function GroupMemberContextRow({
  entry,
  status,
  actions,
  onNavigate,
}: {
  entry: GroupMemberContext;
  status?: ReactNode;
  actions?: ReactNode;
  /** Called when a link of the row leaves the dialog. */
  onNavigate?: () => void;
}) {
  const { t, formatNumber } = useT();
  const { member, reading, configuredModel } = entry;
  const model = nonEmpty(reading?.model) ?? nonEmpty(configuredModel);
  const fallback = isFallbackModel(reading, configuredModel);
  const percent = reading?.percent ?? null;

  return (
    <li data-group-member-context={member.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <BotFace name={member.name} seed={member.id} face={member.face} className="size-7 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{member.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {model ? <span className="truncate">{model}</span> : null}
            {fallback ? (
              <span className="shrink-0 rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-4">
                {t("threadContext.groupFallback")}
              </span>
            ) : null}
          </span>
        </div>
        {actions}
        <Link
          to="/bot/$botId"
          params={{ botId: member.id }}
          onClick={onNavigate}
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("threadContext.groupChangeModel")}
        </Link>
      </div>
      {status}
      {reading ? (
        <div className="flex flex-col gap-1">
          {percent !== null ? (
            <div
              role="progressbar"
              aria-label={member.name}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-foreground/70" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {reading.window > 0
              ? `${t("threadContext.readout", { used: formatNumber(reading.used), window: formatNumber(reading.window) })} · ${t("threadContext.inline", { percent: formatNumber(Math.round((percent ?? 0) * 10) / 10) })}`
              : t("threadContext.readoutUnbounded", { used: formatNumber(reading.used) })}
          </span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{t("threadContext.groupNoMeasure")}</span>
      )}
    </li>
  );
}

/** A member's « modèle indisponible » state, under its model's row. */
function ModelUnavailableStatus({ state }: { state: ModelUnavailableState }) {
  const { t } = useT();
  return (
    <span role="alert" data-model-unavailable="" className="flex items-center gap-1.5 text-xs font-medium text-destructive">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      {state.model
        ? t("threadContext.groupModelUnavailable", { model: state.model })
        : t("threadContext.groupModelUnavailableNoModel")}
    </span>
  );
}

/** Statuses of a run still alive: the server refuses to summarize for as long as one remains. */
const LIVE_RUN_STATUSES = new Set(["queued", "starting", "running", "awaiting_approval"]);

/**
 * Text characters of the salon that the summary has not covered yet. The
 * messages carry their sequence (`ThreadMessageDto.sequence`); without it, one
 * counts them all. An estimate: the server stays the authority (422).
 */
export function pendingCompactionChars(
  messages: readonly ThreadMessageDto[],
  compaction: ThreadCompactionDto | null | undefined,
): number {
  const watermark = compaction?.compactedThroughSequence ?? -1;
  let total = 0;
  for (const message of messages) {
    if (message.sequence !== undefined && Number(message.sequence) <= watermark) continue;
    for (const part of message.content) {
      if (part.type === "text") total += part.text.length;
    }
  }
  return total;
}

/**
 * The « Compacter l'historique du salon » gesture: an action on the whole thread
 * (compaction is per thread, not per member), so under the list and not on
 * a row. Reserved to those who operate the workspace, like the route.
 */
function CompactRoomHistory({
  threadId,
  messages,
  compaction,
  busy,
}: {
  threadId: string;
  messages: readonly ThreadMessageDto[];
  compaction: ThreadCompactionDto | null | undefined;
  /** A member is still answering: the server would answer 409. */
  busy: boolean;
}) {
  const { t, formatDate, plural } = useT();
  const queryClient = useQueryClient();
  const compact = useMutation({
    mutationFn: () => api.compactThread(threadId),
    onSuccess: (result) => {
      toast.success(plural(result.summarizedCount, {
        one: t("threadContext.compactDone_one", { count: result.summarizedCount }),
        other: t("threadContext.compactDone_other", { count: result.summarizedCount }),
      }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError && error.message ? error.message : t("threadContext.compactFailed"));
      // A 409 « tour en cours » or a summary already done elsewhere: the thread has moved.
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(threadId) });
    },
  });

  const tooShort = pendingCompactionChars(messages, compaction) < ROOM_COMPACT_MIN_CHARS;
  const reason = compact.isPending
    ? t("threadContext.compactRunning")
    : busy
      ? t("threadContext.compactBusy")
      : tooShort
        ? t("threadContext.compactTooShort")
        : t("threadContext.compactHint");

  return (
    <div data-group-compact="" className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
      {compaction ? (
        <span data-group-compacted-until="" className="text-xs text-muted-foreground">
          {t("threadContext.compactedUntil", { date: formatDate(compaction.compactedAt, { dateStyle: "medium", timeStyle: "short" }) })}
        </span>
      ) : null}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={compact.isPending || busy || tooShort}
          aria-busy={compact.isPending}
          aria-describedby={`compact-reason-${threadId}`}
          onClick={() => compact.mutate()}
        >
          {compact.isPending ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          {t("threadContext.compactButton")}
        </Button>
        <span id={`compact-reason-${threadId}`} className="min-w-0 text-xs text-muted-foreground">{reason}</span>
      </div>
    </div>
  );
}

export function GroupContextTab({
  members,
  bots,
  runs,
  events = [],
  variant = "header",
  threadId,
  messages = [],
  compaction,
}: {
  members: readonly GroupContextMember[];
  /** The roster: each member's configured model and Hermes profile. */
  bots: readonly Pick<BotDto, "id" | "model" | "hermesProfile">[];
  runs: readonly RunDto[];
  events?: readonly StoredProductEvent[];
  /**
   * `header`: the top bar's chip (desktop). `inline`: a line
   * of text for the mobile header's subtitle. The detail opens in the
   * same dialog.
   */
  variant?: "header" | "inline";
  /** The salon's thread: without it, the dialog does not offer to compact. */
  threadId?: string;
  /** The thread's loaded messages, to estimate what is left to summarize. */
  messages?: readonly ThreadMessageDto[];
  /** How far the salon is already summarized (`ThreadSnapshot.compaction`). */
  compaction?: ThreadCompactionDto | null;
}) {
  const { t, formatNumber, formatDate } = useT();
  const [open, setOpen] = useState(false);

  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const privileged = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  // The route requires `requireOperator`: owner and admin.
  const canCompact = canOperateWorkspace(auth.data?.session.role ?? "");
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: privileged });
  const runtimeId = runtimes.data?.runtimes[0]?.id ?? null;
  // One window per member (its Hermes profile, its model). React Query
  // dedupes identical profiles: a few reads at most.
  const profiles = members.map((member) => bots.find((bot) => bot.id === member.id)?.hermesProfile ?? null);
  const contexts = useQueries({
    queries: profiles.map((profile) => modelContextQueryOptions(runtimeId, profile, privileged)),
  });

  const unavailable = modelUnavailableByBot(runs);
  const entries: GroupMemberContext[] = members.map((member, index) => {
    const bot = bots.find((candidate) => candidate.id === member.id);
    const context = contexts[index]?.data;
    const configuredModel = nonEmpty(bot?.model) ?? nonEmpty(context?.model);
    return {
      member,
      configuredModel,
      modelUnavailable: unavailable.get(member.id) ?? null,
      reading: botContextReading({
        botId: member.id,
        runs,
        events,
        configuredModel,
        runtimeWindow: context?.status === "ok" ? context.contextWindow : 0,
        preamble: context?.status === "ok" ? context.preamble ?? null : null,
        t,
      }),
    };
  });

  // A refused model comes before any gauge: this member no longer answers at
  // all, even with no measurement. Otherwise, no member measured: no
  // chip (a gauge at zero would say « il reste tout » of a crew one does not
  // know anything about).
  const alerted = entries.find((entry) => entry.modelUnavailable) ?? null;
  const busiest = alerted ?? busiestMember(entries);
  if (!busiest) return null;

  const { reading } = busiest;
  const percent = reading?.percent ?? null;
  const readout = !reading
    ? ""
    : reading.window > 0
      ? t("threadContext.readout", { used: formatNumber(reading.used), window: formatNumber(reading.window) })
      : t("threadContext.readoutUnbounded", { used: formatNumber(reading.used) });
  const alertLabel = alerted?.modelUnavailable
    ? alerted.modelUnavailable.model
      ? t("threadContext.groupModelUnavailable", { model: alerted.modelUnavailable.model })
      : t("threadContext.groupModelUnavailableNoModel")
    : null;
  const label = alertLabel ?? (percent !== null
    ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
    : readout);
  const title = `${busiest.member.name} · ${alertLabel ?? readout}`;

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          data-group-context-header=""
          onClick={() => setOpen(true)}
          aria-label={t("threadContext.groupOpen")}
          data-alert={alertLabel ? "model-unavailable" : undefined}
          title={title}
          className={`inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-body-2-medium tabular-nums outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring ${alertLabel ? "text-destructive" : "text-text-secondary hover:text-text-primary"}`}
        >
          <BotFace name={busiest.member.name} seed={busiest.member.id} face={busiest.member.face} className="size-4" />
          {/* The same pie as `ThreadContextTab`: unknown ceiling, the disc
              stays empty and it is the tokens that are written. */}
          {alertLabel ? (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <span
              aria-hidden
              className="size-3.5 shrink-0 rounded-full opacity-80 shadow-[inset_0_0_0_1.5px_currentColor]"
              style={{ background: `conic-gradient(currentColor ${percent ?? 0}%, transparent 0)` }}
            />
          )}
          <span className="whitespace-nowrap">{label}</span>
        </button>
      ) : (
        <button
          type="button"
          data-group-context-inline=""
          onClick={() => setOpen(true)}
          aria-label={t("threadContext.groupOpen")}
          data-alert={alertLabel ? "model-unavailable" : undefined}
          title={title}
          className={`openedbot-press inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl text-[13px] leading-4 ${alertLabel ? "text-destructive" : "text-muted-foreground"} outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring`}
        >
          <BotFace name={busiest.member.name} seed={busiest.member.id} face={busiest.member.face} className="size-4" />
          <span className="truncate tabular-nums">{label}</span>
        </button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("threadContext.groupTitle")}
        description={t("threadContext.groupDescription")}
        closeLabel={t("common.close")}
        className="max-w-lg"
      >
        <ul className="flex flex-col divide-y divide-border">
          {entries.map((entry) => (
            <GroupMemberContextRow
              key={entry.member.id}
              entry={entry}
              status={entry.modelUnavailable ? <ModelUnavailableStatus state={entry.modelUnavailable} /> : undefined}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </ul>
        {threadId !== undefined && canCompact ? (
          <CompactRoomHistory
            threadId={threadId}
            messages={messages}
            compaction={compaction}
            busy={runs.some((candidate) => LIVE_RUN_STATUSES.has(candidate.status))}
          />
        ) : compaction ? (
          // No right to compact, but the summary's state stays readable.
          <p data-group-compacted-until="" className="mt-4 text-xs text-muted-foreground">
            {t("threadContext.compactedUntil", { date: formatDate(compaction.compactedAt, { dateStyle: "medium", timeStyle: "short" }) })}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
