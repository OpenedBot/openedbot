import { useRef, useState } from "react";
import type { ProviderUsageSnapshotDto, ProviderUsageWindowDto } from "@openedbot/contracts-api";
import { Tooltip, TooltipContent, TooltipTrigger, cn, syncPulse } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { BRAND_MARKS, type BrandMarkKey } from "../brand-marks";
import { ProviderLimitsDialog } from "../dashboard/provider-limits-card";
import { useProviderLimits, type ProviderLimits } from "../dashboard/provider-limits-panel";
import { elapsedMinutes, resetLabel, statusMessage } from "../dashboard/provider-limits-parts";

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
 * The three logos' place before the first reading: a faded logo in a
 * neutral track that pulses, inert and silent (no state to announce yet).
 */
export function RailLlmQuotasLoading({ buttonClassName }: { buttonClassName: string }) {
  return (
    <div aria-hidden data-rail-llm-quotas="loading" className="flex shrink-0 items-center gap-1">
      {RAIL_QUOTA_FAMILIES.map((family) => (
        <span key={family.key} data-rail-quota={family.key} data-rail-quota-state="loading" className={cn(buttonClassName, "pointer-events-none")}>
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
    </div>
  );
}

/**
 * The remaining LLM quota at GPT, Anthropic and Grok, just above the runtime
 * in the rail: the three logos, stacked in this order, each in a
 * ring filled with what remains on the account's window furthest spent.
 * Each logo has its tooltip (and the same text for the accessible name); a click
 * opens the full reading, or the model settings for a family with no
 * account connected.
 *
 * The same read, cached, as the composer's tab (`useProviderLimits`):
 * no extra request. Nothing for a member (quotas are read by
 * owners and admins). During the first read (on reload, it
 * waits for the secondary reads, ~1.5 s), the three logos already hold their
 * place (`RailLlmQuotasLoading`): they no longer pop up above the runtime.
 */
export function RailLlmQuotas({ buttonClassName }: { buttonClassName: string }) {
  const { t } = useT();
  const openSettings = useOpenSettings();
  const [open, setOpen] = useState(false);
  /*
    The modal returns focus to the logo that opened it, and the Radix tooltip
    opens on any focus that does not come from a click: it reappeared on
    close. That return focus is swallowed once; hovering the logo
    lifts the rule, and the tooltip comes back on hover.
  */
  const swallowFocusRef = useRef(false);
  const limits = useProviderLimits(open);
  if (!limits.canView) return null;
  if (limits.runtimePending || (limits.runtimeId !== null && limits.pending)) return <RailLlmQuotasLoading buttonClassName={buttonClassName} />;
  if (limits.runtimeId === null) return null;
  const families = railQuotaFamilies(limits);
  const broken = limits.readFailed || limits.status === "error" || limits.status === "disconnected";
  if (!broken && families.every((family) => family.reading.state === "off")) return null;
  const context = railQuotaContext(limits, t);
  return (
    <>
      <div role="group" aria-label={t("railQuotas.title")} data-rail-llm-quotas="" className="flex shrink-0 items-center gap-1">
        {families.map((family) => {
          const line = railQuotaLine(family, t);
          const off = family.reading.state === "off";
          return (
            <Tooltip key={family.key}>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!swallowFocusRef.current) return;
                  swallowFocusRef.current = false;
                  event.preventDefault();
                }}
                onPointerMove={() => { swallowFocusRef.current = false; }}
              >
                <button
                  type="button"
                  data-rail-quota={family.key}
                  data-rail-quota-state={family.reading.state}
                  aria-haspopup={off ? undefined : "dialog"}
                  aria-label={[line, ...context].join(" ")}
                  // The rail's pitch (36 px); 44 pt to the finger on a coarse pointer.
                  className={cn(
                    buttonClassName,
                    "pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:rounded-[inherit] pointer-coarse:before:content-['']",
                  )}
                  onClick={() => (off ? openSettings("/settings/models") : setOpen(true))}
                >
                  <QuotaMark family={family} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                {/* One row per piece of information: the tooltip content lays out as a row by default. */}
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium">{line}</p>
                  {context.map((item) => <p key={item}>{item}</p>)}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <ProviderLimitsDialog
        open={open}
        onClose={() => {
          swallowFocusRef.current = true;
          setOpen(false);
        }}
        limits={limits}
      />
    </>
  );
}
