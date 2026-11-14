import * as React from "react";
import { cn } from "../../lib/utils";
import { Reveal } from "./reveal";
import { ShimmerLabel } from "./agent-thinking";
import { Branch, Stem, TRUNK_LEFT } from "./connectors";

/**
 * Le plan d'un tour, en bloc repliable. Porté du bloc `agent-progress` de
 * BoardUI : chaque étape entre en escalier, l'étape en cours porte son anneau,
 * une étape franchie se coche et se barre, et le bloc réduit garde son compte.
 *
 * Écart assumé avec l'amont, et c'est le fond du sujet : la démonstration
 * BoardUI avance sur un minuteur, `stepDuration` par tâche. Ici rien n'avance
 * tout seul. Les étapes viennent des écritures `todo` réellement observées
 * dans le transcript du run. Un plan qui ne bouge pas est un plan que le
 * modèle n'a pas touché, et c'est l'information juste.
 */

export type AgentStepStatus = "pending" | "active" | "done" | "cancelled";
export type AgentStep = { id: string; label: string; status: AgentStepStatus };

/** Le pas d'escalier entre deux entrées de rangée. */
const STEP_STAGGER_MS = 90;

/* ---------------------------------------------------------------- glyphes */

/** Le disque coché d'une étape franchie, le trait se dessinant à l'arrivée. */
function StepCheck({ animate }: { animate: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-[15px]">
      <circle cx="7" cy="7" r="7" fill="var(--color-agent-track)" />
      <path
        d="M4 7.5 5.646 9.146a.5.5 0 0 0 .708 0L10 5.5"
        fill="none"
        stroke="var(--color-muted-foreground)"
        strokeWidth="1.5"
        strokeLinecap="round"
        pathLength={1}
        className={animate ? "openedbot-agent-check" : undefined}
      />
    </svg>
  );
}

/**
 * L'anneau de l'étape en cours. Il avance sans jamais boucler : seul le
 * modèle sait quand l'étape se termine, une jauge qui se remplirait
 * annoncerait une fin que personne ne connaît.
 */
function StepRing() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-[15px] -rotate-90">
      <circle cx="7" cy="7" r="6" fill="none" stroke="var(--color-agent-track)" strokeWidth="2" />
      <circle
        cx="7"
        cy="7"
        r="6"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="animate-agent-step-ring"
      />
    </svg>
  );
}

/** L'étape abandonnée : le disque reste, la croix remplace la coche. */
function StepCancelled() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-[15px]">
      <circle cx="7" cy="7" r="7" fill="var(--color-agent-track)" />
      <path
        d="m4.6 4.6 4.8 4.8m0-4.8-4.8 4.8"
        fill="none"
        stroke="var(--color-muted-foreground)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** L'étape encore à faire : un disque creux, sans promesse. */
function StepPending() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-[15px]">
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="var(--color-agent-track)"
        strokeWidth="2"
      />
    </svg>
  );
}

function StepGlyph({ status, animate }: { status: AgentStepStatus; animate: boolean }) {
  if (status === "done") return <StepCheck animate={animate} />;
  if (status === "active") return <StepRing />;
  if (status === "cancelled") return <StepCancelled />;
  return <StepPending />;
}

/* ---------------------------------------------------------------- rangée */

/**
 * Une étape, au pas d'une rangée du journal d'outils : `py-1` sur une ligne de
 * 20 px pose son centre à 14 px, là où le coude de `Branch` arrive.
 */
function StepRow({ step, animate }: { step: AgentStep; animate: boolean }) {
  const struck = step.status === "done" || step.status === "cancelled";
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <span className="flex size-[15px] shrink-0 items-center justify-center">
        <StepGlyph status={step.status} animate={animate} />
      </span>
      {step.status === "active" ? (
        <ShimmerLabel className="block min-w-0 max-w-full truncate text-body-regular">
          {step.label}
        </ShimmerLabel>
      ) : (
        <span
          className={cn(
            "relative block min-w-0 max-w-full truncate text-body-regular transition-colors duration-300",
            struck ? "text-muted-foreground" : "text-muted-foreground/60",
          )}
        >
          {step.label}
          {struck ? (
            <span
              aria-hidden
              className={cn(
                "absolute top-1/2 right-0 left-0 h-px origin-left bg-current opacity-80",
                animate && "animate-agent-strike",
              )}
            />
          ) : null}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ bloc */

export type AgentProgressProps = {
  /** Le titre quand des étapes restent, « Plan d'exécution ». */
  title: string;
  /** Le titre quand tout est franchi, « Toutes les étapes sont passées ». */
  completedTitle?: string;
  /**
   * `warn` : le plan est clos mais un outil du même tour a échoué. Le titre
   * passe en ambre pour ne pas se lire comme un tour sans accroc.
   */
  completedTone?: "neutral" | "warn";
  /** Le décompte restant, déjà mis au pluriel par l'appelant. */
  remainingLabel?: (remaining: number) => string;
  steps: AgentStep[];
  defaultCollapsed?: boolean;
  /** Libellés du bouton de repli, pour les lecteurs d'écran. */
  expandLabel: string;
  collapseLabel: string;
  /** Le glyphe de tête, sur la colonne de 16 px du journal d'outils. */
  icon?: React.ReactNode;
  className?: string;
};

export function AgentProgress({
  title,
  completedTitle,
  completedTone = "neutral",
  remainingLabel,
  steps,
  defaultCollapsed = false,
  expandLabel,
  collapseLabel,
  icon,
  className,
}: AgentProgressProps) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const remaining = steps.filter(
    (step) => step.status === "pending" || step.status === "active",
  ).length;
  const finished = remaining === 0 && steps.length > 0;

  // Un plan rouvert après coup ne rejoue pas son entrée : le fil se relit,
  // il ne se remet pas en scène.
  const animate = !defaultCollapsed;

  const heading = finished
    ? completedTitle ?? title
    : remainingLabel
      ? remainingLabel(remaining)
      : title;

  // À plat, sans carte : le plan est la première branche de la trace du tour,
  // avec la tête, le tronc et les coudes du journal d'outils et de la
  // recherche web. En carte grise, il était le seul bloc rempli du tour et
  // se lisait comme collé par-dessus.
  return (
    <section className={cn("flex w-fit max-w-full flex-col", className)}>
      <button
        type="button"
        onClick={() => setCollapsed((previous) => !previous)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? expandLabel : collapseLabel}
        data-agent-toggle=""
        className="group flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {icon ? (
          <span
            aria-hidden
            className="relative flex size-4 shrink-0 items-center justify-center bg-[var(--agent-glyph-mask,var(--color-background))] text-muted-foreground"
          >
            {icon}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 truncate text-body-regular",
            finished && completedTone === "warn" ? "text-warn-700" : "text-muted-foreground",
          )}
        >
          {heading}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform duration-300 ease-out group-hover:text-muted-foreground",
            collapsed ? "" : "rotate-180",
          )}
        >
          <path
            d="M4 6.5 8 10.5l4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {/* Le repli ferme la même piste de grille que l'entrée d'une rangée :
          la liste se range vers le haut au lieu de disparaître d'un coup. */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr", opacity: collapsed ? 0 : 1 }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative">
            <Stem height={6} />
            <ul className="flex flex-col" style={{ marginLeft: TRUNK_LEFT }}>
              {steps.map((step, index) => (
                <Reveal
                  key={step.id}
                  delayMs={animate ? index * STEP_STAGGER_MS : 0}
                  instant={!animate}
                >
                  <li className="relative min-w-0 overflow-hidden pl-4">
                    <Branch last={index === steps.length - 1} />
                    <StepRow step={step} animate={animate} />
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
