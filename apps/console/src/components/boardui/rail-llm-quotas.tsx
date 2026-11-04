import { useRef, useState } from "react";
import type { ProviderUsageSnapshotDto, ProviderUsageWindowDto } from "@openedbot/contracts-api";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { BRAND_MARKS, type BrandMarkKey } from "../brand-marks";
import { ProviderLimitsDialog } from "../dashboard/provider-limits-card";
import { useProviderLimits, type ProviderLimits } from "../dashboard/provider-limits-panel";
import { elapsedMinutes, resetLabel, statusMessage } from "../dashboard/provider-limits-parts";

type Translate = ReturnType<typeof useT>["t"];

/**
 * Les trois familles que le rail suit toujours, dans cet ordre (demande
 * opérateur du 04-11-2026). Une famille regroupe les slugs Hermes d'un même
 * vendeur : `openai-codex` et `openai-api` sont tous deux « GPT ».
 */
export const RAIL_QUOTA_FAMILIES = [
  { key: "gpt", name: "GPT", mark: "openai", match: (slug: string) => slug.startsWith("openai") },
  { key: "anthropic", name: "Anthropic", mark: "anthropic", match: (slug: string) => slug.startsWith("anthropic") || slug.startsWith("claude") },
  { key: "grok", name: "Grok", mark: "grok", match: (slug: string) => slug.startsWith("xai") || slug.startsWith("grok") },
] as const satisfies ReadonlyArray<{ key: string; name: string; mark: BrandMarkKey; match: (slug: string) => boolean }>;

export type RailQuotaFamilyKey = (typeof RAIL_QUOTA_FAMILIES)[number]["key"];

export type RailQuotaReading =
  /** Aucun compte de cette famille n'est branché sur le runtime. */
  | { state: "off" }
  | { state: "measured"; provider: string; remaining: number; resetAt: string | null }
  /** Une clé API facturée à l'usage : pas de forfait, donc rien de « restant ». */
  | { state: "apiKey"; provider: string }
  /** Branché, mais sans relevé : fournisseur sans API de compte, ou lecture en échec. */
  | { state: "unmeasured"; provider: string; failed: boolean };

export type RailQuotaFamily = { key: RailQuotaFamilyKey; name: string; mark: BrandMarkKey; reading: RailQuotaReading };

/*
  Hermes marque `scope: "model"` les fenêtres qui ne plafonnent qu'une famille
  de modèles (Anthropic « Opus week », « Sonnet week ») ; la sonde de l'hôte ne
  relaie pas ce champ. Une telle fenêtre à 100 % ne vide pas le compte : elle
  ne compte pas pour le « restant » du rail, et reste lisible dans le panneau.
*/
const MODEL_SCOPED_WINDOW = /^(opus|sonnet|haiku|fable)\b/i;

/** La fenêtre de compte la plus entamée : c'est le mur que l'on heurtera en premier. */
export function bindingWindow(snapshot: ProviderUsageSnapshotDto): ProviderUsageWindowDto | null {
  let binding: ProviderUsageWindowDto | null = null;
  for (const window of snapshot.windows) {
    if (window.usedPercent === null || MODEL_SCOPED_WINDOW.test(window.label.trim())) continue;
    if (binding === null || window.usedPercent > binding.usedPercent!) binding = window;
  }
  return binding;
}

/**
 * L'état d'une famille, à partir des fournisseurs réellement branchés
 * (`limits.providers`, le même prédicat que le panneau). Plusieurs comptes
 * dans une famille : le relevé en service d'abord, puis le plus entamé.
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

/** Mêmes seuils que la jauge du panneau (`UsageBar`), lus côté restant. */
function remainingTone(remaining: number): string {
  if (remaining < 5) return "text-destructive";
  if (remaining < 20) return "text-amber-500";
  return "text-foreground/70";
}

/** La phrase d'une famille : nom, restant et réinitialisation, ou pourquoi il n'y en a pas. */
export function railQuotaLine(family: RailQuotaFamily, t: Translate): string {
  const { reading, name: provider } = family;
  if (reading.state === "off") return t("railQuotas.off", { provider });
  if (reading.state === "apiKey") return t("railQuotas.apiKey", { provider });
  if (reading.state === "unmeasured") return t(reading.failed ? "railQuotas.unavailable" : "railQuotas.unmeasured", { provider });
  const percent = Math.round(reading.remaining);
  const reset = resetLabel(reading.resetAt, t);
  return reset ? t("railQuotas.remainingReset", { provider, percent, reset }) : t("railQuotas.remaining", { provider, percent });
}

/** Ce que l'infobulle d'une famille ajoute sous sa phrase : l'état de la lecture, puis sa date. */
export function railQuotaContext(limits: ProviderLimits, t: Translate): string[] {
  const lines: string[] = [];
  const message = limits.readFailed ? t("providerLimits.readFailed") : statusMessage(limits.status, limits.reason, limits.error, t);
  if (message) lines.push(message);
  if (limits.fetchedAt) lines.push(t("providerLimits.readAt", { minutes: elapsedMinutes(limits.fetchedAt) }));
  return lines;
}

/** Rayon de l'anneau dans une boîte de 28 : trait de 2, aucun bord rogné. */
const RING_R = 12.5;

/**
 * Le vrai logo du fournisseur dans un anneau qui se vide : plein = tout reste,
 * vide = mur atteint. Sans relevé (ou clé API), l'anneau est en pointillés, ni
 * plein ni vide ; sans compte branché, le logo s'efface et l'anneau disparaît :
 * une piste vide se lirait « quota épuisé ».
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
 * La place des trois logos avant le premier relevé : logo estompé dans une
 * piste neutre qui pulse, inerte et muette (aucun état à annoncer encore).
 */
function RailLlmQuotasLoading({ buttonClassName }: { buttonClassName: string }) {
  return (
    <div aria-hidden data-rail-llm-quotas="loading" className="flex shrink-0 flex-col items-center gap-1.5">
      {RAIL_QUOTA_FAMILIES.map((family) => (
        <span key={family.key} data-rail-quota={family.key} data-rail-quota-state="loading" className={cn(buttonClassName, "pointer-events-none")}>
          <span className="relative inline-flex size-7 items-center justify-center motion-safe:animate-pulse">
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
 * Le quota LLM restant chez GPT, Anthropic et Grok, juste au-dessus du runtime
 * dans le rail : les trois logos, empilés dans cet ordre, chacun dans un
 * anneau rempli de ce qui reste sur la fenêtre la plus entamée du compte.
 * Chaque logo a son infobulle (et le même texte pour nom accessible) ; un clic
 * ouvre le relevé complet, ou les réglages des modèles pour une famille sans
 * compte branché.
 *
 * Même lecture, en cache, que l'onglet du composer (`useProviderLimits`) :
 * aucune requête de plus. Rien pour un membre (les quotas sont lus par les
 * owners et admins). Pendant la première lecture (au rechargement, elle
 * attend les lectures secondaires, ~1,5 s), les trois logos tiennent déjà leur
 * place (`RailLlmQuotasLoading`) : ils ne surgissent plus au-dessus du runtime.
 */
export function RailLlmQuotas({ buttonClassName }: { buttonClassName: string }) {
  const { t } = useT();
  const openSettings = useOpenSettings();
  const [open, setOpen] = useState(false);
  /*
    La modale rend le focus au logo qui l'a ouverte, et l'infobulle Radix
    s'ouvre sur tout focus qui ne vient pas d'un clic : elle réapparaissait à
    la fermeture. Ce focus de retour est avalé une fois ; survoler le logo
    lève la consigne, l'infobulle revient au survol.
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
      <div role="group" aria-label={t("railQuotas.title")} data-rail-llm-quotas="" className="flex shrink-0 flex-col items-center gap-1.5">
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
                  // Le pas du rail (36 px) ; 44 pt au doigt sur un pointeur grossier.
                  className={cn(
                    buttonClassName,
                    "pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:rounded-[inherit] pointer-coarse:before:content-['']",
                  )}
                  onClick={() => (off ? openSettings("/settings/models") : setOpen(true))}
                >
                  <QuotaMark family={family} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-72">
                {/* Une ligne par information : le contenu de l'infobulle se pose en rangée par défaut. */}
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
