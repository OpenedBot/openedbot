import * as React from "react";
import { cn } from "../../lib/utils";
import { Reveal } from "./reveal";
import { AgentThinking } from "./agent-thinking";
import { Branch } from "./connectors";

/**
 * Le journal de ce qu'un agent a fait. Porté du bloc `task-list` de BoardUI :
 * chaque tâche porte un titre repliable, et sous lui les gestes qu'elle a
 * demandés, reliés par un coude. Une tâche qui tourne fait scintiller son
 * titre, et l'indicateur de travail suit la queue du journal.
 *
 * Écart assumé avec l'amont : la démonstration BoardUI déroule ses étapes sur
 * un intervalle, `stepInterval`. Ici chaque rangée est un appel d'outil
 * réellement observé, avec sa durée mesurée et son issue. Rien n'est déroulé
 * pour faire joli.
 */

export type TaskChip = {
  label: string;
  /** Le glyphe du type de ressource, déjà dimensionné par l'appelant. */
  icon?: React.ReactNode;
};

export type TaskStepState = "running" | "done" | "failed";

export type TaskStep = {
  id: string;
  /** Ce que l'étape a fait, « Lit », « Cherche dans le web ». */
  label: React.ReactNode;
  /** Les fichiers ou ressources touchés, rendus en pastilles après le libellé. */
  chips?: TaskChip[];
  /** Le détail à droite : une durée, un compte de résultats. */
  meta?: React.ReactNode;
  state?: TaskStepState;
  /** Ce qui se déplie SOUS la rangée : un message d'erreur, un résultat. */
  detail?: React.ReactNode;
};

export type Task = {
  id: string;
  /** Le titre de la tâche, tel qu'il se lit une fois close. */
  title: React.ReactNode;
  steps: TaskStep[];
  state?: TaskStepState;
  /** Le glyphe de tête, à gauche du titre. */
  icon?: React.ReactNode;
  /** Le détail à droite du titre : durée totale, compte d'échecs. */
  meta?: React.ReactNode;
  /** Le bloc ouvre replié quand la tâche est close et sans surprise. */
  defaultCollapsed?: boolean;
  /**
   * Ouverture pilotée par l'appelant. Le journal du fil a sa propre règle,
   * déplié tant qu'un appel tourne, et doit pouvoir l'imposer.
   */
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
};

const STEP_STAGGER_MS = 90;

/** Une pastille de ressource : le fichier ou l'objet que l'étape a touché. */
function Chip({ chip }: { chip: TaskChip }) {
  return (
    <span className="mr-0.5 ml-[3px] inline-flex max-w-full -translate-y-px items-center gap-1 rounded-md border border-border/50 bg-surface py-0.5 pr-1.5 pl-1 align-middle text-[11px] leading-[15px] font-medium transition-colors duration-150 ease-out hover:border-border hover:bg-surface-hover">
      {chip.icon ? (
        <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
          {chip.icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{chip.label}</span>
    </span>
  );
}

function StepRow({ step, last }: { step: TaskStep; last: boolean }) {
  return (
    <li className="relative min-w-0 overflow-hidden pl-4">
      <Branch last={last} />
      <div
        className={cn(
          "min-w-0 py-1 text-body-regular",
          step.state === "failed" ? "text-destructive-text" : "text-muted-foreground",
        )}
      >
        <span className={step.state === "running" ? "openedbot-agent-label" : undefined}>{step.label}</span>
        {step.chips?.map((chip, index) => <Chip key={index} chip={chip} />)}
        {step.meta ? (
          <span className="ml-2 shrink-0 tabular-nums text-muted-foreground/80">{step.meta}</span>
        ) : null}
        {step.detail}
      </div>
    </li>
  );
}

function TaskSection({ task }: { task: Task }) {
  const [ownCollapsed, setOwnCollapsed] = React.useState(task.defaultCollapsed ?? false);
  const controlled = task.expanded !== undefined;
  const collapsed = controlled ? !task.expanded : ownCollapsed;
  const setCollapsed = (next: boolean) => {
    if (controlled) task.onExpandedChange?.(!next);
    else setOwnCollapsed(next);
  };
  const animate = !(task.defaultCollapsed ?? false);

  return (
    <section className="overflow-hidden">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        data-agent-toggle=""
        // `w-fit` : la durée et la flèche suivent le titre. En pleine largeur
        // avec un titre en `flex-1`, elles partaient au bord droit du fil.
        className="group flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {task.icon ? (
          // `relative` + fond de `--agent-glyph-mask` (repli : `--color-background`) :
          // le glyphe masque le tronc de la trace du tour qui passe dessous
          // (`TrailItem`), à la couleur de la surface du fil.
          <span aria-hidden className="relative flex size-4 shrink-0 items-center justify-center bg-[var(--agent-glyph-mask,var(--color-background))] text-muted-foreground">
            {task.icon}
          </span>
        ) : null}
        <span className={cn("min-w-0 truncate text-body-medium text-muted-foreground", task.state === "running" && "openedbot-agent-label")}>
          {task.title}
        </span>
        {task.meta ? (
          <span className="shrink-0 text-body-regular tabular-nums text-muted-foreground/80">
            {task.meta}
          </span>
        ) : null}
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
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr", opacity: collapsed ? 0 : 1 }}
      >
        <div className="min-h-0 overflow-hidden">
          <ul aria-live="polite" className="mt-0.5 ml-2 flex flex-col">
            {task.steps.map((step, index) => (
              <Reveal
                key={step.id}
                delayMs={animate ? index * STEP_STAGGER_MS : 0}
                instant={!animate}
              >
                <StepRow step={step} last={index === task.steps.length - 1} />
              </Reveal>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export type TaskListProps = {
  tasks: Task[];
  /** Posé, l'indicateur de travail suit la queue du journal. */
  working?: { label: string; startedAt?: string | null } | null;
  className?: string;
};

export function TaskList({ tasks, working = null, className }: TaskListProps) {
  return (
    <div className={cn("flex w-fit max-w-full flex-col gap-[5px]", className)}>
      {tasks.map((task) => (
        <TaskSection key={task.id} task={task} />
      ))}
      {working ? (
        <AgentThinking
          variant="infinity"
          label={working.label}
          startedAt={working.startedAt ?? null}
          className="pt-0.5"
        />
      ) : null}
    </div>
  );
}
