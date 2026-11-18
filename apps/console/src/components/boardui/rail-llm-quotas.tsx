import { useCallback, useRef, useState } from "react";
import type { ProviderUsageSnapshotDto, ProviderUsageWindowDto } from "@openedbot/contracts-api";
import { Popover, Tooltip, TooltipContent, TooltipTrigger, cn, syncPulse } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import type { RuntimeHealthReading } from "../../lib/runtime/use-runtime-health";
import { BRAND_MARKS, type BrandMarkKey } from "../brand-marks";
import { ProviderLimitsDialog } from "../dashboard/provider-limits-card";
import { useProviderLimits, type ProviderLimits } from "../dashboard/provider-limits-panel";
import { elapsedMinutes, resetLabel, statusMessage } from "../dashboard/provider-limits-parts";
import { RailRuntimeDot, RailRuntimeHealth, railRuntimeIcon, railRuntimeLines, railRuntimeState } from "./rail-runtime-health";

type Translate = ReturnType<typeof useT>["t"];

/**
 * The three families the rail always follows, in this order (operator
 * request of 04-11-2026). A family groups one vendor's Hermes slugs:
 * `openai-codex` and `openai-api` are both « GPT ».
 */
export const RAIL_QUOTA_FAMILIES = [
  { key: "gpt", name: "GPT", mark: "openai", match: (slug: string) => slug.startsWith("openai") },
  { key: "anthropic", name: "Anthropic", mark: "anthropic", match: (slug: string) => slug.startsWith("anthropic") || slug.startsWith("claude") },
  { key: "grok", name: "Grok", mark: "grok", match: (slug: string) => slug.startsWith("xai") || slug.startsWith("grok") },
] as const satisfies ReadonlyArray<{ key: string; name: string; mark: BrandMarkKey; match: (slug: string) => boolean }>;

export type RailQuotaFamilyKey = (typeof RAIL_QUOTA_FAMILIES)[number]["key"];

export type RailQuotaReading =
  /** No account of this family is connected to the runtime. */
  | { state: "off" }
  | { state: "measured"; provider: string; remaining: number; resetAt: string | null }
  /** A usage-billed API key: no plan, so nothing « restant ». */
  | { state: "apiKey"; provider: string }
  /** Connected, but with no reading: a provider with no account API, or a read that failed. */
  | { state: "unmeasured"; provider: string; failed: boolean };

export type RailQuotaFamily = { key: RailQuotaFamilyKey; name: string; mark: BrandMarkKey; reading: RailQuotaReading };

/*
  Hermes marks `scope: "model"` the windows that cap only one family
  of models (Anthropic « Opus week », « Sonnet week »); the host's probe does not
  relay this field. Such a window at 100% does not empty the account: it
  does not count toward the rail's « restant », and stays readable in the panel.
*/
const MODEL_SCOPED_WINDOW = /^(opus|sonnet|haiku|fable)\b/i;

/** The account window furthest spent: the wall one will hit first. */
export function bindingWindow(snapshot: ProviderUsageSnapshotDto): ProviderUsageWindowDto | null {
  let binding: ProviderUsageWindowDto | null = null;
  for (const window of snapshot.windows) {
    if (window.usedPercent === null || MODEL_SCOPED_WINDOW.test(window.label.trim())) continue;
    if (binding === null || window.usedPercent > binding.usedPercent!) binding = window;
  }
  return binding;
}

/**
 * A family's state, from the providers actually connected
 * (`limits.providers`, the same predicate as the panel). Several accounts
 * in a family: the in-service reading first, then the furthest spent.
 */
export function railQuotaFamilies(limits: Pick<ProviderLimits, "providers" | "snapshots" | "inService">): RailQuotaFamily[] {
  return RAIL_QUOTA_FAMILIES.map(({ key, name, mark, match }) => {
    const slugs = limits.providers.map((provider) => provider.slug).filter(match);
    if (slugs.length === 0) return { key, name, mark, reading: { state: "off" } };
    let measured: { provider: string; used: number; resetAt: string | null; inService: boolean } | null = null;
    for (const slug of slugs) {
      const snapshot = limits.snapshots.get(slug);
      const window = snapshot ? bindingWindow(snapshot) : null;
      if (!window) continue;
      const candidate = { provider: slug, used: window.usedPercent!, resetAt: window.resetAt, inService: limits.inService.has(slug) };
      if (
        measured === null
        || (candidate.inService && !measured.inService)
        || (candidate.inService === measured.inService && candidate.used > measured.used)
      ) measured = candidate;
    }
    if (measured) {
      const remaining = Math.max(0, Math.min(100, 100 - measured.used));
      return { key, name, mark, reading: { state: "measured", provider: measured.provider, remaining, resetAt: measured.resetAt } };
    }
    const apiKey = slugs.find((slug) => limits.snapshots.get(slug)?.source === "api_key");
    if (apiKey) return { key, name, mark, reading: { state: "apiKey", provider: apiKey } };
    const snapshot = limits.snapshots.get(slugs[0]!);
    return { key, name, mark, reading: { state: "unmeasured", provider: slugs[0]!, failed: snapshot === undefined || snapshot.source === "unavailable" } };
  });
}

/**
 * The ring speaks the runtime badge's colours (`rail-runtime-health`), right
 * below it: green at rest, warning from 35% remaining, red from 10%
 * (operator request of 08-11-2026). Earlier than the panel's thresholds on
 * purpose: the rail is where the wall is seen coming.
 */
export function remainingTone(remaining: number): string {
  if (remaining <= 10) return "text-destructive";
  if (remaining <= 35) return "text-warn-700";
  return "text-pos-700";
}

/** A family's sentence: name, remaining and reset, or why there is none. */
export function railQuotaLine(family: RailQuotaFamily, t: Translate): string {
  const { reading, name: provider } = family;
  if (reading.state === "off") return t("railQuotas.off", { provider });
  if (reading.state === "apiKey") return t("railQuotas.apiKey", { provider });
  if (reading.state === "unmeasured") return t(reading.failed ? "railQuotas.unavailable" : "railQuotas.unmeasured", { provider });
  const percent = Math.round(reading.remaining);
  const reset = resetLabel(reading.resetAt, t);
  return reset ? t("railQuotas.remainingReset", { provider, percent, reset }) : t("railQuotas.remaining", { provider, percent });
}

/** What a family's tooltip adds under its sentence: the state of the read, then its date. */
export function railQuotaContext(limits: ProviderLimits, t: Translate): string[] {
  const lines: string[] = [];
  const message = limits.readFailed ? t("providerLimits.readFailed") : statusMessage(limits.status, limits.reason, limits.error, t);
  if (message) lines.push(message);
  if (limits.fetchedAt) lines.push(t("providerLimits.readAt", { minutes: elapsedMinutes(limits.fetchedAt) }));
  return lines;
}

/** The ring's radius in a box of 28: a stroke of 2, no edge clipped. */
const RING_R = 12.5;

/**
 * The provider's real logo in a ring that empties: full = everything remains,
 * empty = wall reached. With no reading (or an API key), the ring is dotted, neither
 * full nor empty; with no account connected, the logo fades and the ring disappears:
 * an empty track would read as « quota épuisé ».
 */
function QuotaMark({ family }: { family: RailQuotaFamily }) {
  const { reading } = family;
  const mark = BRAND_MARKS[family.mark];
  return (
    <span aria-hidden className="relative inline-flex size-7 items-center justify-center">
      <svg viewBox="0 0 28 28" className="absolute inset-0 size-7 -rotate-90 overflow-visible">
        {reading.state === "measured" ? (
          <>
            <circle cx="14" cy="14" r={RING_R} fill="none" strokeWidth="2" className="stroke-foreground/15" />
            <circle
              cx="14" cy="14" r={RING_R} fill="none" strokeWidth="2" strokeLinecap="round" stroke="currentColor"
              pathLength={100}
              strokeDasharray={`${reading.remaining} 100`}
              className={cn("transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none", remainingTone(reading.remaining))}
            />
          </>
        ) : reading.state === "off" ? null : (
          <circle
            cx="14" cy="14" r={RING_R} fill="none" strokeWidth="1.5" strokeDasharray="2 2.5" stroke="currentColor"
            className={reading.state === "unmeasured" && reading.failed ? "text-warn-700" : "text-foreground/35"}
          />
        )}
      </svg>
      <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className={cn("size-3.5", reading.state === "off" && "opacity-35")}>
        <path d={mark.path} />
      </svg>
    </span>
  );
}


/**
 * A pill of the rail's foot row: the rail's 36 px pitch, no label (its name is
 * the tooltip and the accessible name), so « Modèles » and « Connecteurs »
 * share one row with Settings (operator request of 17-11-2026).
 */
export const RAIL_PILL = "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-button-default text-foreground";

/** The models pill's padding: 4 px around a 28 px ring, room for the dot. */
const MODELS_PILL = cn(RAIL_PILL, "ps-1 pe-2.5");

/**
 * Hovered, a pill grows a little: a transform, so its neighbours do not move.
 * Pressed, it settles back.
 */
export const RAIL_PILL_BUTTON = cn(
  "cursor-pointer outline-none transition-[transform,background-color] duration-200 ease-out hover:scale-[1.06] hover:bg-board-row-hover active:scale-100 focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-expanded:bg-board-row-hover motion-reduce:transition-none motion-reduce:hover:scale-100",
  // 44 pt to the finger on a coarse pointer.
  "pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:rounded-[inherit] pointer-coarse:before:content-['']",
);

/** One row of the popover: a mark, then its sentences. */
export const POPOVER_ROW = "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-start text-body-2-regular text-foreground outline-none transition-colors duration-150 hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring motion-reduce:transition-none";

/** The three marks before the first reading: a faded logo in a neutral track that pulses, inert and silent. */
function QuotaMarksLoading() {
  return (
    <span aria-hidden data-rail-llm-quotas="loading" className="flex items-center">
      {RAIL_QUOTA_FAMILIES.map((family) => (
        <span key={family.key} data-rail-quota={family.key} data-rail-quota-state="loading" className="inline-flex">
          {/* `syncPulse`: same beat as the boot silhouette it replaces. */}
          <span ref={syncPulse} className="relative inline-flex size-7 items-center justify-center motion-safe:animate-pulse">
            <svg viewBox="0 0 28 28" className="absolute inset-0 size-7 overflow-visible">
              <circle cx="14" cy="14" r={RING_R} fill="none" strokeWidth="2" className="stroke-foreground/15" />
            </svg>
            <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" className="size-3.5 opacity-35">
              <path d={BRAND_MARKS[family.mark].path} />
            </svg>
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The pill before the role is known, also drawn by the frame skeleton
 * (`RailFooterSkeleton`): the same box as the live pill, so nothing moves
 * when the reading lands.
 */
export function RailModelsPillLoading() {
  return (
    <span aria-hidden data-rail-models-pill="loading" className={MODELS_PILL}>
      <QuotaMarksLoading />
      <RailRuntimeDot state="pending" />
    </span>
  );
}

/**
 * « Modèles » at the foot of the conversations card, one pill: the GPT,
 * Anthropic and Grok logos side by side, each in a ring filled with what
 * remains on the account's window furthest spent, then the runtime's health
 * as a dot (operator request of 17-11-2026, after a « Connectors » pill).
 * A click opens a popover: one row per family (the full reading, or the model
 * settings for a family with no account connected), then the runtime row.
 *
 * The same read, cached, as the composer's tab (`useProviderLimits`): no
 * extra request. No logo for a member (quotas are read by owners and admins),
 * nor when none of the three families is connected: the pill then shows the
 * runtime's own icon before its dot. Until the first reading (the role, the runtime, the
 * catalogue, then the quotas; and the host probe after an API restart), the
 * three logos hold their place: they neither vanish nor pop up.
 */
export function RailModelsPill({ runtime, onOpenSettings }: { runtime: RuntimeHealthReading; onOpenSettings: (to: string) => void }) {
  const { t, formatDate, locale } = useT();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const limits = useProviderLimits(limitsOpen);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // The ui-kit popover leaves focus where it was: the panel takes it, so the keyboard
  // lands on the rows. Stable, so a re-render (a new reading) does not pull focus back.
  const focusFirstRow = useCallback((node: HTMLDivElement | null) => node?.querySelector("button")?.focus(), []);

  // The frame opens before `/api/auth/me` answers (`lib/session/app-access-hint.ts`):
  // an unknown role keeps the three slots, and the runtime stays reachable.
  let families: RailQuotaFamily[] | "loading" | null = null;
  if (limits.authPending) families = "loading";
  else if (limits.canView) {
    if (limits.runtimePending || (limits.runtimeId !== null && limits.pending)) families = "loading";
    else if (limits.runtimeId !== null) {
      const read = railQuotaFamilies(limits);
      const broken = limits.readFailed || limits.status === "error" || limits.status === "disconnected";
      if (broken || read.some((family) => family.reading.state !== "off")) {
        // The API has no reading yet and probes the host (its cache is per process,
        // empty after a restart): a reading on its way is not « indisponible ».
        // An open reading stays open.
        families = limits.status === "loading" && !limitsOpen ? "loading" : read;
      }
    }
  }
  const context = Array.isArray(families) ? railQuotaContext(limits, t) : [];
  const runtimeState = railRuntimeState(runtime);
  const RuntimeIcon = railRuntimeIcon(runtime.runtime);
  const label = t("railQuotas.pill");
  const summary = [
    label,
    ...(Array.isArray(families) ? families.map((family) => railQuotaLine(family, t)) : []),
    ...railRuntimeLines(runtime, t, formatDate, locale),
  ].join(" ");

  return (
    <>
      <Popover
        side="top"
        align="start"
        width={300}
        className="p-1.5"
        trigger={({ ref, onClick, "aria-expanded": expanded }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={(node) => {
                  ref(node);
                  pillRef.current = node;
                }}
                type="button"
                data-rail-models-pill=""
                aria-haspopup="dialog"
                aria-expanded={expanded}
                aria-label={summary}
                className={cn(MODELS_PILL, RAIL_PILL_BUTTON)}
                onClick={onClick}
              >
                {families === "loading" ? <QuotaMarksLoading /> : Array.isArray(families) ? (
                  <span aria-hidden data-rail-llm-quotas="" className="flex items-center">
                    {families.map((family) => (
                      <span key={family.key} data-rail-quota={family.key} data-rail-quota-state={family.reading.state} className="inline-flex">
                        <QuotaMark family={family} />
                      </span>
                    ))}
                  </span>
                ) : (
                  <span aria-hidden className="inline-flex size-7 items-center justify-center text-foreground-icon-secondary">
                    <RuntimeIcon className="size-[18px]" />
                  </span>
                )}
                <RailRuntimeDot state={runtimeState} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{label}</TooltipContent>
          </Tooltip>
        )}
      >
        {(close) => (
          <div ref={focusFirstRow} className="flex flex-col">
            {Array.isArray(families) ? (
              <>
                <div role="group" aria-label={t("railQuotas.title")} className="flex flex-col">
                  {families.map((family) => {
                    const line = railQuotaLine(family, t);
                    const off = family.reading.state === "off";
                    return (
                      <button
                        key={family.key}
                        type="button"
                        data-rail-quota={family.key}
                        data-rail-quota-state={family.reading.state}
                        aria-haspopup={off ? undefined : "dialog"}
                        aria-label={[line, ...context].join(" ")}
                        className={POPOVER_ROW}
                        onClick={() => {
                          close();
                          if (off) onOpenSettings("/settings/models");
                          else {
                            // The modal gives focus back to what held it: the pill, not this row, which unmounts.
                            pillRef.current?.focus();
                            setLimitsOpen(true);
                          }
                        }}
                      >
                        <QuotaMark family={family} />
                        <span className="min-w-0">{line}</span>
                      </button>
                    );
                  })}
                </div>
                {context.length > 0 ? (
                  <p className="px-2 pt-0.5 pb-1.5 text-caption-1-regular text-text-tertiary">{context.join(" · ")}</p>
                ) : null}
                <div aria-hidden className="mx-2 my-1 h-px bg-border" />
              </>
            ) : null}
            <RailRuntimeHealth
              reading={runtime}
              className={POPOVER_ROW}
              onOpenSettings={(to) => {
                close();
                onOpenSettings(to);
              }}
            />
          </div>
        )}
      </Popover>
      <ProviderLimitsDialog open={limitsOpen} onClose={() => setLimitsOpen(false)} limits={limits} />
    </>
  );
}
