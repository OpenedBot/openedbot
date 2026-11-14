import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Folder, X } from "lucide-react";
import type { ContextPreambleDto, RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { fallbackContextWindow } from "@openedbot/runtimes/domain/runtime/model-context-window";
import {
  contextUsageBreakdown,
  contextUsageTools,
  isContextUsageReading,
  type ContextUsageReading,
} from "@openedbot/runtimes/domain/runtime/context-usage";
import {
  AgentContextMeter,
  AgentLimitsCard,
  cn,
  Dialog,
  Skeleton,
  SkeletonRegion,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type AgentBudgetGroup,
  type AgentBudgetSegment,
  type AgentPlanLimit,
  useCoarsePointer,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { api, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  ProviderLimitsPanel,
  providerLimitsWorthShowing,
  resetLabel,
  useProviderLimits,
  type ProviderLimits,
} from "./dashboard/provider-limits-panel";
import { useSecondaryReadsReady } from "../lib/shell/after-first-paint";
import { canvasChromeButton, useAttachmentCanvas } from "./attachment-canvas";

/**
 * The status tab hooked to the composer's top edge, and its detail.
 *
 * Two things, and only those: what the last turn occupied of the
 * context window, and where the provider account's quotas stand. The
 * first is a local measurement (`runs.usage`), the second comes from the host
 * (`/hermes-setup/usage`). Neither is estimated here.
 *
 * The context window, for its part, is NOT a local measurement: the Hermes
 * gateway publishes it nowhere. A host that serves `edge-setup` gives it
 * (`/hermes-setup/model-context`); otherwise one falls back to the local table
 * `fallbackContextWindow`, and without that either no ceiling is shown.
 */

/** What the last completed turn actually put in the window. */
export type ThreadContextReading = {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
};

/**
 * The last run that returned a usage. One walks back up the thread: a run in flight does not
 * have a usage yet, and a failed run sometimes has a partial one that no longer describes
 * the session's state.
 */
export function lastContextReading(runs: readonly RunDto[]): ThreadContextReading | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.status !== "completed" || !run.usage) continue;
    const inputTokens = Math.max(0, Math.floor(run.usage.inputTokens));
    const outputTokens = Math.max(0, Math.floor(run.usage.outputTokens));
    if (inputTokens + outputTokens <= 0) continue;
    // `run.model` is the model that ran THIS turn, provider fallback
    // included. `runtimeSession` stays read for an earlier API.
    return { inputTokens, outputTokens, model: nonEmpty(run.model) ?? nonEmpty(run.runtimeSession?.model) };
  }
  return null;
}

/**
 * An empty string is not a value: the host returns `model: ""` when it cannot
 * say, and `??` would let it through as a model name. That is what
 * made the context window fall to « inconnue » while the thread
 * knew perfectly well which model it was running on.
 */
export function nonEmpty(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * What the model had in hand on the last turn, as the worker measured it
 * at close. The last reading wins: the earlier ones describe a turn
 * that is over.
 */
export function lastContextUsage(
  events: readonly StoredProductEvent[],
): ContextUsageReading | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const reading = events[index]!.payload.contextUsage;
    if (isContextUsageReading(reading)) return reading;
  }
  return null;
}

type Translate = ReturnType<typeof useT>["t"];

/**
 * The window, line by line, in the BoardUI card's order: what
 * really occupies it first, the preamble next, then what is listed without
 * being counted (MCP, unmeasured). Three sources, each said for what it
 * is:
 *
 *  - the turn, measured by the worker (`contextUsage`), line by line when the
 *    reading carries its detail, in two blocks for an older reading,
 *    and failing that the last billed `usage`;
 *  - Hermes's preamble (identity, memory, skills, tool schemas),
 *    measured on the host (`RuntimeModelContextDto.preamble`);
 *  - nothing for what cannot be measured: an « non mesuré » line is listed
 *    with a dash, it does not invent a figure for itself.
 */
export function contextBudget({
  occupancy,
  reading,
  preamble,
  t,
}: {
  occupancy: ContextUsageReading | null;
  reading: ThreadContextReading;
  preamble: ContextPreambleDto | null;
  t: Translate;
}): { segments: AgentBudgetSegment[]; groups: AgentBudgetGroup[] } {
  const segments: AgentBudgetSegment[] = [];
  const groups: AgentBudgetGroup[] = [];
  const breakdown = occupancy ? contextUsageBreakdown(occupancy) : null;
  // A line at zero is not information: it only lengthens the
  // list. « Messages » stays, it is the line that always exists.
  const counted = (label: string, value: number) => {
    if (value > 0) segments.push({ label, value });
  };

  if (breakdown) {
    segments.push({
      label: t("threadContext.segmentMessages"),
      value: breakdown.history + breakdown.input + breakdown.reply,
    });
    counted(t("threadContext.segmentToolResults"), breakdown.toolResults);
    counted(t("threadContext.segmentToolCalls"), breakdown.toolCalls);
    counted(t("threadContext.segmentReasoning"), breakdown.reasoning);
    counted(t("threadContext.segmentInstructions"), breakdown.instructions);
  } else if (occupancy) {
    segments.push(
      { label: t("threadContext.segmentConversation"), value: Math.max(0, occupancy.tokens - occupancy.toolTokens) },
      { label: t("threadContext.segmentToolResults"), value: occupancy.toolTokens },
    );
  } else {
    segments.push(
      { label: t("threadContext.segmentInput"), value: reading.inputTokens },
      { label: t("threadContext.segmentOutput"), value: reading.outputTokens },
    );
  }

  const tools = occupancy ? contextUsageTools(occupancy) : [];
  if (tools.length > 0) {
    groups.push({
      label: t("threadContext.groupTurnTools"),
      value: tools.reduce((sum, tool) => sum + tool.tokens, 0),
      items: tools.map((tool) => ({
        label: tool.name,
        value: tool.tokens,
        detail: tool.calls > 0
          ? t(tool.calls > 1 ? "threadContext.toolCallsMany" : "threadContext.toolCallsOne", { count: tool.calls })
          : undefined,
      })),
    });
  }

  if (!preamble) {
    // The host does not measure its preamble yet: it exists, that is said, and the
    // bar does not invent its size.
    segments.push({ label: t("threadContext.segmentPreambleUnknown"), value: null, deferred: true });
    return { segments, groups };
  }

  const bucket = (key: ContextPreambleDto["buckets"][number]["key"]) =>
    preamble.buckets.find((candidate) => candidate.key === key) ?? null;
  const preambleSegment = (
    key: ContextPreambleDto["buckets"][number]["key"],
    label: string,
    unmeasuredLabel: string,
    groupLabel: string | null,
  ) => {
    const found = bucket(key);
    if (!found) return;
    if (found.tokens === null) segments.push({ label: unmeasuredLabel, value: null, deferred: true });
    else counted(label, found.tokens);
    if (groupLabel && found.items.length > 0) {
      groups.push({
        label: groupLabel,
        value: found.tokens,
        items: found.items.map((item) => ({ label: item.name, value: item.tokens })),
      });
    }
  };
  preambleSegment("tools", t("threadContext.segmentSystemTools"), t("threadContext.segmentSystemToolsUnmeasured"), t("threadContext.groupSystemTools"));
  preambleSegment("skills", t("threadContext.segmentSkills"), t("threadContext.segmentSkills"), t("threadContext.groupSkills"));
  preambleSegment("identity", t("threadContext.segmentIdentity"), t("threadContext.segmentIdentity"), null);
  preambleSegment("memory", t("threadContext.segmentMemory"), t("threadContext.segmentMemory"), t("threadContext.groupMemory"));
  preambleSegment("mcp", t("threadContext.segmentMcp"), t("threadContext.segmentMcp"), t("threadContext.groupMcp"));
  return { segments, groups };
}

/**
 * The plan limits of the providers IN SERVICE, one line per window
 * (5 h, week, ...), like the bottom of the BoardUI card. A connected account
 * that nothing uses stays in the Quotas tab: it is not this thread's wall.
 */
export function planLimits(limits: ProviderLimits, t: Translate): { label: string; rows: AgentPlanLimit[] } | null {
  const serviced = limits.providers
    .filter((provider) => limits.inService.has(provider.slug))
    .map((provider) => {
      const snapshot = limits.snapshots.get(provider.slug);
      const windows = (snapshot?.windows ?? []).filter((window) => window.usedPercent !== null);
      return { provider, plan: snapshot?.plan ?? null, windows };
    })
    .filter((entry) => entry.windows.length > 0);
  if (serviced.length === 0) return null;
  const single = serviced.length === 1 ? serviced[0]! : null;
  const rows = serviced.flatMap(({ provider, windows }) => windows.map((window, index): AgentPlanLimit => {
    const reset = resetLabel(window.resetAt, t);
    return {
      id: `${provider.slug}:${index}`,
      label: single ? window.label : `${provider.name} · ${window.label}`,
      used: (window.usedPercent ?? 0) / 100,
      resets: reset ? t("providerLimits.resetIn", { reset }) : null,
    };
  }));
  return {
    label: single
      ? t("threadContext.planLimits", { plan: single.plan ?? single.provider.name })
      : t("threadContext.planLimitsAll"),
    rows,
  };
}

/**
 * A model's context window. The runtime wins (it alone knows
 * its host's config override), then the upstream table, then the
 * hard ceiling the upstream applies to an unknown model. Shared by a bot's
 * thread and by each member of a crew.
 */
export function resolveContextWindow(runtimeWindow: number, model: string | null): number {
  return runtimeWindow > 0 ? runtimeWindow : (fallbackContextWindow(model) ?? 0);
}

/**
 * The window reading for a Hermes profile. It moves only on a
 * model change: one reading per (runtime, profile) is enough, and the API
 * keeps it for a quarter of an hour on its side.
 */
export function modelContextQueryOptions(runtimeId: string | null, hermesProfile: string | null, enabled: boolean) {
  return {
    queryKey: queryKeys.runtimeModelContext(runtimeId ?? "none", hermesProfile),
    queryFn: () => api.runtimeModelContext(runtimeId!, hermesProfile),
    enabled: enabled && runtimeId !== null,
    staleTime: 10 * 60_000,
  };
}

/** What a bot (a crew member) occupied of its window on its last turn. */
export type BotContextReading = {
  reading: ThreadContextReading;
  /** The model of the last completed turn, provider fallback included. */
  model: string | null;
  window: number;
  /** Tokens counted in the window. */
  used: number;
  /** `null` when the window is unknown: a percentage is not invented. */
  percent: number | null;
};

/**
 * The reading of ONE bot in a thread that gathers several (a crew): only
 * its runs are kept, and those runs' events. Each member has its own
 * Hermes session, therefore its own model and its own window. `null` for as long as
 * it has no completed turn that returned a usage.
 */
export function botContextReading({
  botId,
  runs,
  events = [],
  configuredModel,
  runtimeWindow,
  preamble = null,
  t,
}: {
  botId: string;
  runs: readonly RunDto[];
  events?: readonly StoredProductEvent[];
  /** The bot's configured model, otherwise the one the host gives for its profile. */
  configuredModel: string | null;
  runtimeWindow: number;
  preamble?: ContextPreambleDto | null;
  t: Translate;
}): BotContextReading | null {
  const botRuns = runs.filter((run) => run.botId === botId);
  const reading = lastContextReading(botRuns);
  if (!reading) return null;
  const runIds = new Set(botRuns.map((run) => run.id));
  const occupancy = lastContextUsage(events.filter((event) => runIds.has(event.runId)));
  const window = resolveContextWindow(runtimeWindow, reading.model ?? nonEmpty(configuredModel));
  const budget = contextBudget({ occupancy, reading, preamble, t });
  const used = budget.segments.reduce((sum, segment) => sum + (segment.deferred ? 0 : segment.value ?? 0), 0);
  return { reading, model: reading.model, window, used, percent: window > 0 ? Math.min(100, (used / window) * 100) : null };
}

export function ThreadContextTab({
  runs,
  events = [],
  botModel,
  hermesProfile,
  variant = "tab",
}: {
  runs: readonly RunDto[];
  /** The thread, to reread there the session occupancy set at a run's close. */
  events?: readonly StoredProductEvent[];
  /**
   * The thread's model when no turn has been measured yet: the bot's
   * setting, otherwise the runtime's default (`ThreadSnapshot.effectiveModel`). A bot
   * that inherits the runtime has an empty `bots.model`, and passing that empty value here deprived
   * the context window of the only model name available.
   */
  botModel: string | null;
  hermesProfile: string | null;
  /**
   * `tab`: the tab hooked to the composer's top edge (desktop).
   * `inline`: a line of text for the mobile header's subtitle,
   * like the « en ligne » under a name in WhatsApp. The composer stays a
   * pill; the detail opens in the same dialog.
   * `header`: the top bar's chip (desktop), a pie and the
   * percentage, next to the model.
   * `status`: the 16 px ring and the percentage of the line under the
   * composer (same dialog, same data as the other variants).
   */
  variant?: "tab" | "inline" | "header" | "status";
}) {
  const { t, formatNumber } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState<"context" | "quotas">("context");
  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  /*
    The detail opens in the canvas on the right, beside the thread: it is while reading
    the conversation that one looks at what it costs, and a modal hid it.
    Outside a canvas provider (tests, a screen with no canvas), the dialog stays.
    `panelId` distinguishes the triggers mounted together: only the one that
    opened fills the slot.
  */
  const canvas = useAttachmentCanvas();
  const panelId = useId();
  const open = canvas ? canvas.panel?.id === panelId : dialogOpen;
  const canvasSlot = canvas?.panelSlot?.owner === panelId ? canvas.panelSlot.element : null;
  const reading = lastContextReading(runs);

  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const privileged = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: privileged });
  const runtimeId = runtimes.data?.runtimes[0]?.id ?? null;
  const secondaryReady = useSecondaryReadsReady();
  const context = useQuery(modelContextQueryOptions(runtimeId, hermesProfile, privileged && secondaryReady));
  // The provider statement is at home here: it is the quota's single surface,
  // and the composer is where one decides to spend. The per-bot detail
  // is read only once the dialog is open.
  const limits = useProviderLimits(open);
  // The canvas opens at once; while its readings arrive, it shows
  // the result's silhouette. `isLoading` and not `isPending`: a request
  // that is disabled (no runtime, a reader without the right) stays `pending` forever, and
  // the silhouette would never finish.
  const detailLoading = auth.isLoading
    || runtimes.isLoading
    || context.isLoading
    || (limits.pending && limits.busy);

  // From the most precise to the most general: the measured turn's model, the thread's,
  // then what the host says of its current model. Each stage is filtered of the
  // empty, otherwise an `""` from the host won against a perfectly known name.
  const model = reading?.model ?? nonEmpty(botModel) ?? nonEmpty(context.data?.model);
  const runtimeWindow = context.data?.status === "ok" ? context.data.contextWindow : 0;
  const window = resolveContextWindow(runtimeWindow, model);
  /*
    Two magnitudes, and only one fills the window.

    `occupancy`: what the model had IN HAND on the last turn, measured on what
    was sent to it plus what the turn made grow. It is neither the
    session's size (openedbot bounds each turn's history: measured, a
    session went from 22 000 to 198 000 tokens while the send stayed flat
    at 29 300) nor the cost.

    `turnCost`: what the turn BILLED. Ten tool calls pay for ten
    prompts each carrying the whole context: measured on a real thread, 143 223
    tokens billed for a much smaller context. Set against the window, this
    number goes past 100% without anything overflowing. It stays written, as a cost.
  */
  const occupancy = lastContextUsage(events);
  const turnCost = reading ? reading.inputTokens + reading.outputTokens : 0;
  const preamble = context.data?.status === "ok" ? context.data.preamble ?? null : null;

  // Nothing measured: no tab. A bar at zero for a thread that has never
  // run would say « il reste tout », when nothing is known.
  if (!reading) return null;

  // The chip and the card say the same number: the sum of the lines
  // counted, the host's preamble included when it is measured.
  const budget = contextBudget({ occupancy, reading, preamble, t });
  const used = budget.segments.reduce((sum, segment) => sum + (segment.deferred ? 0 : segment.value ?? 0), 0);
  const percent = window > 0 ? Math.min(100, (used / window) * 100) : 0;
  const plan = planLimits(limits, t);
  // With no measured account, the Quotas tab would list only « sans relevé »:
  // the dialog then reduces to the context, with no tab bar.
  const showQuotas = providerLimitsWorthShowing(limits);
  const activeTab = showQuotas ? tab : "context";

  const readout = window > 0
    ? t("threadContext.readout", { used: formatNumber(used), window: formatNumber(window) })
    : t("threadContext.readoutUnbounded", { used: formatNumber(used) });

  const closeDetail = () => {
    if (canvas) canvas.close();
    else setDialogOpen(false);
  };
  // Reopened, the detail resumes on the thread one was looking at. The trigger
  // closes the canvas it opened itself, like a switch.
  const toggleDetail = () => {
    if (open) {
      closeDetail();
      return;
    }
    setTab("context");
    if (canvas) canvas.openPanel({ id: panelId, label: t("threadContext.title") });
    else setDialogOpen(true);
  };
  // While reading, the full title: the quota statement is not
  // there yet to say whether there will be two tabs, and the title must not
  // change under one's eyes once the figures have arrived.
  const detailTitle = showQuotas || detailLoading ? t("threadContext.title") : t("threadContext.windowLabel");
  const detailDescription = showQuotas || detailLoading ? t("threadContext.description") : undefined;

  const contextBody = (
    <>
      <AgentLimitsCard
        defaultExpanded
        budget={window > 0 ? {
          label: t("threadContext.windowLabel"),
          readout,
          max: window,
          segments: budget.segments,
          groups: budget.groups,
          formatValue: (value) => formatNumber(value),
        } : null}
        // The bottom of the card: the windows of the plan in service. The
        // arrow opens the full statement (every account, reread).
        limits={plan ? {
          ...plan,
          action: showQuotas ? { label: t("threadContext.planLimitsOpen"), onClick: () => setTab("quotas") } : undefined,
        } : null}
        formatPercent={(value) => t("threadContext.inline", {
          percent: formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        })}
        formatLimitPercent={(value) => t("providerLimits.usedPercentValue", { percent: Math.round(value) })}
        freeLabel={t("threadContext.free")}
        expandLabel={t("threadContext.expand")}
        collapseLabel={t("threadContext.collapse")}
      />
      {/* The last turn's cost is read apart: it is not a share
          of the window, it is what the call billed. */}
      <p className="mt-3 text-xs leading-snug text-muted-foreground">
        {t("threadContext.turnCost", { tokens: formatNumber(turnCost) })}
      </p>
    </>
  );

  /* Two subjects, two tabs. Stacked, the context breakdown and the
     subscription statement read as a single list of figures, and
     a provider's quota passed for a share of the window. The context
     opens first: it is the thread one was looking at. With no measured account, there
     is only one subject: the detail is the context. */
  const detailBody = showQuotas ? (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setTab(value === "quotas" ? "quotas" : "context")}
      className="gap-3"
    >
      <TabsList className="w-full">
        <TabsTrigger value="context">{t("threadContext.tabContext")}</TabsTrigger>
        <TabsTrigger value="quotas">
          {t("threadContext.tabQuotas")}
          {/* The peak in service, when there is one: the tab says what it
              contains without one having to open it. */}
          {limits.servicePeak !== null ? (
            <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[11px] leading-4 tabular-nums">
              {t("providerLimits.usedPercentValue", { percent: Math.round(limits.servicePeak) })}
            </span>
          ) : null}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="context" className="flex flex-col">
        {contextBody}
      </TabsContent>

      <TabsContent value="quotas">
        <ProviderLimitsPanel limits={limits} onNavigate={closeDetail} />
      </TabsContent>
    </Tabs>
  ) : (
    <div className="flex flex-col">{contextBody}</div>
  );

  return (
    <>
      {variant === "header" ? (
        <button
          type="button"
          data-thread-context-header=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          className="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-body-2-medium text-text-secondary tabular-nums outline-none transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {/* A solid pie, not a ring: next to the model, a thin arc
              read as a loading spinner. Unknown ceiling: the disc stays empty
              and it is the token count that is written. */}
          <span
            aria-hidden
            className="size-3.5 shrink-0 rounded-full opacity-80 shadow-[inset_0_0_0_1.5px_currentColor]"
            style={{ background: `conic-gradient(currentColor ${window > 0 ? percent : 0}%, transparent 0)` }}
          />
          <span className="whitespace-nowrap">
            {window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
          </span>
        </button>
      ) : variant === "status" ? (
        <button
          type="button"
          data-thread-context-status=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          className="openedbot-press -me-2 flex shrink-0 cursor-pointer items-center rounded-[40px] outline-none transition-colors duration-150 hover:bg-background-tertiary-default/60 focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          {/* Unknown ceiling: the track stays bare and the token count
              is written, as in the other variants. */}
          <AgentContextMeter
            className="bg-transparent text-foreground-icon-secondary"
            textClassName="text-body-2-medium text-text-secondary"
            percent={window > 0 ? percent : null}
            readout={window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
            label={readout}
          />
        </button>
      ) : variant === "inline" ? (
        <button
          type="button"
          data-thread-context-inline=""
          onClick={toggleDetail}
          aria-label={t("threadContext.open")}
          title={readout}
          // The same hover as the neighbouring model picker (`ThreadModelPicker`):
          // the composer's two controls read as clickable. The
          // height and the padding stay on desktop: as the subtitle of
          // the mobile header, the text keeps its alignment.
          className="openedbot-press inline-flex shrink-0 cursor-pointer items-center rounded-xl text-[13px] leading-4 text-muted-foreground outline-none transition-colors duration-150 hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring sm:h-8 sm:px-2"
        >
          <span className="truncate tabular-nums">
            {window > 0
              ? t("threadContext.inline", { percent: formatNumber(Math.round(percent * 10) / 10) })
              : readout}
          </span>
        </button>
      ) : (
      <>
      {/* The tab is ONE with the shell: a border on three sides, and
          `-mb-px` so its base covers the card's top stroke.
          It is that one-pixel overlap that makes it read as a
          tab of the composer and not as a floating label. */}
      <button
        type="button"
        data-thread-context-tab=""
        onClick={toggleDetail}
        aria-label={t("threadContext.open")}
        className="openedbot-press -mb-px flex h-[34px] w-full min-w-0 items-center justify-between gap-3 rounded-t-[16px] bg-[#ebebeb] px-2 py-1 text-[13px] font-medium text-[#737373] outline-none transition-colors hover:bg-[#e3e3e3] focus-visible:ring-2 focus-visible:ring-ring md:cursor-pointer dark:bg-muted/60 dark:text-muted-foreground dark:hover:bg-muted"
      >
        {/* On the left the profile that runs, on the right what the turn cost.
            The MODEL is not repeated here: the composer's picker carries it
            already, two lines below, and saying it twice teaches nothing. */}
        <span className="flex min-w-0 items-center gap-3 pl-1.5">
          {hermesProfile ? (
            <span
              className="flex min-w-0 items-center gap-1"
              title={t("threadContext.profile", { profile: hermesProfile })}
            >
              <Folder className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{hermesProfile}</span>
            </span>
          ) : null}
        </span>
        {/* A single chip in both cases. Known ceiling: the ring
            fills and the percentage is written. Unknown ceiling: the track stays
            bare and it is the token count that is written, with no arc at zero that
            would claim everything is left. */}
        {/* The track follows the text colour: on the tab's grey,
            `--color-agent-track` faded out and a 10% arc read as
            a spinner. The percentage says what it measures, with no hover. */}
        <AgentContextMeter
          className="bg-transparent [&_circle:first-child]:stroke-current [&_circle:first-child]:[stroke-opacity:0.25]"
          percent={window > 0 ? percent : null}
          readout={window > 0
            ? t("threadContext.tabReadout", { percent: formatNumber(Math.round(percent * 10) / 10) })
            : readout}
          label={readout}
        />
      </button>
      </>
      )}

      {canvasSlot ? createPortal(
        <>
          <header
            className={cn(
              "flex shrink-0 items-start gap-2 border-b px-4",
              coarse ? "border-border/60 py-1.5" : "border-border py-3",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <h2 className="truncate text-sm font-medium">{detailTitle}</h2>
              {detailDescription ? (
                <p className="text-xs leading-snug text-muted-foreground">{detailDescription}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={closeDetail}
              aria-label={t("common.close")}
              title={t("common.close")}
              className={canvasChromeButton(coarse)}
            >
              <X className="size-4" />
            </button>
          </header>
          <div
            className={cn(
              "scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3",
              isMobile && "pb-[max(0.75rem,var(--openedbot-safe-bottom))]",
            )}
          >
            {detailLoading ? <ThreadContextSkeleton label={t("common.loading")} /> : detailBody}
          </div>
        </>,
        canvasSlot,
      ) : null}

      {canvas ? null : (
        <Dialog
          open={dialogOpen}
          onClose={closeDetail}
          title={detailTitle}
          description={detailDescription}
          closeLabel={t("common.close")}
          className="max-w-lg"
        >
          {detailLoading ? <ThreadContextSkeleton label={t("common.loading")} /> : detailBody}
        </Dialog>
      )}
    </>
  );
}

/**
 * The detail's silhouette, at the result's geometry: the tab bar, the
 * window card (title, gauge, one line per item), the plan
 * limits, then the card footnotes. Heights close to the real
 * content: nothing jumps when the figures arrive.
 */
function ThreadContextSkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label} className="flex flex-col gap-3" data-thread-context-skeleton="">
      <Skeleton className="h-9 w-full rounded-lg" />
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-4 [--skeleton:var(--muted)] dark:[--skeleton:#404040]">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/4" />
        </div>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <div className="flex flex-col gap-2.5 pt-1">
          {SKELETON_ROWS.map((width, index) => (
            <div key={index} className="flex items-center gap-2">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-3.5" style={{ width }} />
              <Skeleton className="ms-auto h-3.5 w-12" />
              <Skeleton className="h-3.5 w-10" />
            </div>
          ))}
        </div>
        <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-4">
          <Skeleton className="h-4 w-2/5" />
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="h-3.5 w-1/4" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      </div>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </SkeletonRegion>
  );
}

/** One width per window line, irregular like the real labels. */
const SKELETON_ROWS = ["42%", "50%", "38%", "34%", "46%", "40%", "24%", "36%", "20%"];
