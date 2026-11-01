import { RiListCheck3 } from "@remixicon/react";
import { Button } from "@openedbot/browser-ui-kit";
import type { PlanDraft } from "../lib/plan-draft";
import { useT } from "../lib/i18n";

const actionClass = "min-h-11 min-w-11 flex-[1_1_9rem] px-3 fine:h-8 fine:min-h-8 fine:w-auto fine:min-w-0 fine:flex-none";

/**
 * Checklist de plan, calée sur le canvas BoardUI : compacte, au-dessus du
 * champ, les étapes arrivent une par une pendant que le modèle écrit.
 * La dernière ligne est l'étape en cours de rédaction. Modifier et Lancer
 * n'apparaissent qu'une fois le texte posé.
 */
function PlanCard({
  draft,
  requester,
  writing = false,
  busy = false,
  onEdit,
  onLaunch,
}: {
  draft: PlanDraft;
  requester?: string;
  writing?: boolean;
  busy?: boolean;
  onEdit: () => void;
  onLaunch: () => void;
}) {
  const { t } = useT();
  const label = requester ? `${t("planCard.title")}, ${requester}` : t("planCard.title");
  const liveIndex = writing && draft.steps.length > 0 ? draft.steps.length - 1 : -1;
  const heading = writing || draft.steps.length === 0
    ? t("planCard.writing")
    : t("planCard.stepCount", { count: draft.steps.length });

  return (
    <div
      data-plan-card=""
      role="group"
      aria-label={label}
      aria-busy={writing || undefined}
      className="flex w-full max-w-[22rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-text-tertiary">
          <RiListCheck3 className="size-4" />
        </span>
        <p className="min-w-0 flex-1 truncate text-body-medium text-text-secondary">{heading}</p>
      </div>
      {draft.steps.length ? (
        <ol className="flex flex-col gap-0.5 px-2 pt-1 pb-2">
          {draft.steps.map((step, index) => {
            const live = index === liveIndex;
            return (
              <li
                key={index}
                className={live
                  ? "mx-1 flex min-w-0 items-start gap-2 rounded-full border border-border-button-default px-3 py-1.5 text-body-regular text-text-primary"
                  : "flex min-w-0 items-start gap-2 px-4 py-1 text-body-regular text-text-tertiary"}
              >
                <span aria-hidden className="mt-1 size-3.5 shrink-0 rounded-full border border-current opacity-70" />
                <span className="min-w-0 flex-1 wrap-anywhere">{step}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="px-4 pt-1 pb-3 text-body-regular text-text-tertiary">{draft.objective || t("planCard.preparing")}</p>
      )}
      {!writing && draft.note ? (
        <p className="px-4 pb-2 text-body-regular text-text-tertiary wrap-anywhere">{draft.note}</p>
      ) : null}
      {!writing ? (
        <div className="flex shrink-0 flex-wrap items-stretch gap-2 border-t border-border-button-default px-3.5 pt-3 pb-3.5">
          <Button type="button" variant="secondary" size="sm" onClick={onEdit} className={actionClass}>
            {t("planCard.edit")}
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={busy} onClick={onLaunch} className={actionClass}>
            {t("planCard.launch")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Carte épinglée au-dessus du composer, mobile comme bureau. */
export function PendingPlanDock({
  draft,
  requester,
  writing = false,
  busy = false,
  onEdit,
  onLaunch,
}: {
  draft: PlanDraft;
  requester?: string;
  writing?: boolean;
  busy?: boolean;
  onEdit: () => void;
  onLaunch: () => void;
}) {
  return (
    <div data-plan-dock="" className="flex max-h-[min(70dvh,36rem)] min-h-0 w-full min-w-0 max-w-full shrink flex-col overflow-hidden px-4 pt-2 sm:px-6">
      <PlanCard
        draft={draft}
        requester={requester}
        writing={writing}
        busy={busy}
        onEdit={onEdit}
        onLaunch={onLaunch}
      />
    </div>
  );
}

export function focusPlanComposer(): void {
  document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.focus();
}
