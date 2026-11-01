import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * La carte de budget d'un agent. Portée du bloc `agent-limits-card` de
 * BoardUI : en haut une barre segmentée par poste avec son lu sur total, en
 * bas les limites de plan avec leur pourcentage et leur heure de remise à
 * zéro. Ouverte, la carte détaille chaque poste, les postes différés (listés,
 * hors barre et hors total), l'espace libre, puis des groupes repliables qui
 * nomment leurs membres (outils, skills, fichiers, serveurs).
 *
 * La carte ne mesure rien : chaque nombre vient de l'appelant, déjà attribué.
 * Une valeur `null` se lit « non mesurée » et s'écrit d'un tiret, jamais zéro.
 */

export type AgentBudgetSegment = {
  label: string;
  /** `null` : présent mais non mesuré. Seul un segment différé peut l'être. */
  value: number | null;
  /**
   * La couleur du segment, un jeton `--color-agent-seg-*`. À défaut, la
   * palette de la carte, dans l'ordre des segments comptés.
   */
  color?: string;
  /**
   * Listé, mais hors barre et hors total : ce qui n'occupe pas (encore) la
   * fenêtre, ou ce qu'on ne sait pas mesurer. Pastille grise, tiret à la
   * place du pourcentage.
   */
  deferred?: boolean;
};

export type AgentBudgetGroupItem = {
  label: string;
  value: number | null;
  /** Une précision courte à droite du libellé (« 3 appels »). */
  detail?: string;
};

/** Une liste repliable de membres : chaque groupe s'ouvre seul. */
export type AgentBudgetGroup = {
  label: string;
  value: number | null;
  /** Le nombre de membres, écrit dans la colonne du pourcentage. */
  count?: number;
  items: AgentBudgetGroupItem[];
};

export type AgentPlanLimit = {
  id: string;
  label: string;
  /** Consommé, entre 0 et 1. */
  used: number;
  /** Quand la fenêtre se rouvre, déjà mis en forme par l'appelant. */
  resets: string | null;
};

export type AgentLimitsCardProps = {
  budget: {
    label: string;
    segments: AgentBudgetSegment[];
    /** Les groupes repliables, sous le détail. */
    groups?: AgentBudgetGroup[];
    /** Le plafond, en unités des segments. */
    max: number;
    /** « 820k / 1M », déjà mis en forme par l'appelant. */
    readout: string;
    /**
     * Comment écrire la valeur d'un segment dans le détail déplié. Les jetons
     * se lisent bruts, des octets non : sans ça la carte affiche « 4096 » là
     * où l'écran de facturation dit « 4 ko ».
     */
    formatValue?: (value: number) => string;
  } | null;
  limits: {
    label: string;
    rows: AgentPlanLimit[];
    /** La flèche de l'en-tête : vers le détail des quotas. */
    action?: { label: string; onClick: () => void };
  } | null;
  /** Libellés du bouton de détail, pour les lecteurs d'écran. */
  expandLabel?: string;
  collapseLabel?: string;
  /** Le libellé de l'espace libre, quand la barre en laisse. */
  freeLabel?: string;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Comment écrire un pourcentage déjà borné (0 à 100). L'appelant y met sa
   * locale : « 10,6 % » en français, là où `toFixed` écrivait « 10.6% ».
   */
  formatPercent?: (value: number) => string;
  /** Le pourcentage entier d'une limite de plan (« 38 % »). */
  formatLimitPercent?: (value: number) => string;
  className?: string;
};

/**
 * La palette par défaut, dans l'ordre de l'amont : bleu, violet, rose, jaune,
 * vert, cyan, sarcelle. Neuf jetons, puis elle reboucle.
 *
 * Les variables brutes `--agent-seg-*`, pas les jetons `--color-agent-seg-*` :
 * Tailwind v4 n'émet un jeton de `@theme` que si une classe le référence, et
 * une couleur lue dans une chaîne au rendu n'en référence aucune. Mesuré sur
 * la console : seuls `-1` et `-6` existaient, les autres pastilles restaient
 * vides.
 */
const PALETTE = [6, 5, 3, 8, 7, 4, 1, 9, 2].map((index) => `var(--agent-seg-${index})`);

const DASH = "–";

/** Le pourcentage d'un segment, borné à la fenêtre. */
function percentOf(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/**
 * Toujours au dixième, comme l'amont. L'arrondi à l'entier au-delà de 10 %
 * écrivait « Libre 100% » à côté de « Conversation 0.3% » : 498 283 sur
 * 500 000 vaut 99.7 %, et la ventilation doit sommer à 100.0 %.
 */
function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatLimitPercent(value: number): string {
  return `${Math.round(value)}%`;
}

type ColoredSegment = AgentBudgetSegment & { value: number; color: string };

/** Les segments comptés, chacun avec sa couleur ; les différés à part. */
function splitSegments(segments: AgentBudgetSegment[]): { counted: ColoredSegment[]; deferred: AgentBudgetSegment[] } {
  const counted: ColoredSegment[] = [];
  const deferred: AgentBudgetSegment[] = [];
  for (const segment of segments) {
    if (segment.deferred || segment.value === null) {
      deferred.push(segment);
      continue;
    }
    counted.push({
      ...segment,
      value: Math.max(0, segment.value),
      color: segment.color ?? PALETTE[counted.length % PALETTE.length]!,
    });
  }
  return { counted, deferred };
}

function Chevron({ open, className, direction = "down" }: { open?: boolean; className?: string; direction?: "down" | "right" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn(
        "size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none",
        direction === "down" ? open && "rotate-180" : open && "rotate-90",
        className,
      )}
    >
      <path
        d={direction === "down" ? "M4 6.5 8 10.5l4-4" : "M6.5 4l4 4-4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Une hauteur animée sans mesure : `grid-template-rows` de `0fr` à `1fr`. */
function Collapsible({ open, children, id }: { open: boolean; children: React.ReactNode; id?: string }) {
  return (
    <div
      id={id}
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none"
      style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      // Replié, le contenu ne doit pas recevoir le focus clavier.
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** La barre segmentée : un aplat par poste compté, dans l'ordre reçu. */
function SegmentedBar({
  segments,
  max,
  className,
  label,
  formatValue,
}: {
  segments: ColoredSegment[];
  max: number;
  className?: string;
  label: string;
  formatValue: (value: number) => string;
}) {
  const used = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percentOf(used, max))}
      className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-agent-track", className)}
    >
      {segments.map((segment) => (
        <div
          key={segment.label}
          className="h-full shrink-0 transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percentOf(segment.value, max)}%`, backgroundColor: segment.color }}
          title={`${segment.label} · ${formatValue(segment.value)}`}
        />
      ))}
    </div>
  );
}

/**
 * Une ligne du détail (pastille, libellé, valeur, pourcentage). La liste
 * parente pose les quatre colonnes ; le `li` les reprend en sous-grille
 * pour aligner les chiffres. `whitespace-nowrap` garde « 10,1 % » sur une
 * ligne (espace français devant %).
 */
function BudgetDetailRow({
  color,
  track,
  muted,
  label,
  value,
  percent,
}: {
  color?: string;
  track?: boolean;
  muted?: boolean;
  label: string;
  value: string;
  percent: string;
}) {
  return (
    <li className="col-span-4 grid grid-cols-subgrid items-center">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", track && "bg-agent-track")}
        style={color ? { backgroundColor: color } : undefined}
      />
      <span
        className={cn(
          "min-w-0 truncate text-body-regular",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {label}
      </span>
      <span className="text-right text-body-regular tabular-nums whitespace-nowrap text-muted-foreground">
        {value}
      </span>
      <span className="text-right text-body-medium tabular-nums whitespace-nowrap text-foreground">
        {percent}
      </span>
    </li>
  );
}

/**
 * Un groupe repliable : chevron, libellé, total, nombre de membres. Ouvert,
 * il nomme chaque membre avec sa valeur, en retrait sous son libellé.
 */
function BudgetGroupRow({
  group,
  formatValue,
}: {
  group: AgentBudgetGroup;
  formatValue: (value: number | null) => string;
}) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const empty = group.items.length === 0;
  return (
    <li className="col-span-4 grid grid-cols-subgrid">
      <button
        type="button"
        aria-expanded={empty ? undefined : open}
        aria-controls={empty ? undefined : id}
        disabled={empty}
        onClick={() => setOpen((previous) => !previous)}
        className="group col-span-4 -mx-2 grid grid-cols-subgrid items-center rounded-md px-2 py-0.5 text-left outline-none transition-colors duration-150 enabled:cursor-pointer enabled:hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron
          direction="right"
          open={open}
          className={cn("size-3 text-muted-foreground/60 group-hover:text-muted-foreground", empty && "opacity-0")}
        />
        <span className="min-w-0 truncate text-body-regular text-muted-foreground">{group.label}</span>
        <span className="text-right text-body-regular tabular-nums whitespace-nowrap text-muted-foreground">
          {formatValue(group.value)}
        </span>
        <span className="text-right text-body-regular tabular-nums whitespace-nowrap text-muted-foreground">
          {group.count ?? group.items.length}
        </span>
      </button>
      {empty ? null : (
        <div className="col-span-4">
          <Collapsible open={open} id={id}>
            <ul className="grid grid-cols-[minmax(0,1fr)_max-content] gap-x-2 gap-y-0.5 pt-0.5 pb-1 pl-6">
              {group.items.map((item) => (
                <li key={item.label} className="col-span-2 grid grid-cols-subgrid items-center">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-body-regular text-foreground">{item.label}</span>
                    {item.detail ? (
                      <span className="shrink-0 text-caption-1-regular whitespace-nowrap text-muted-foreground">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right text-body-regular tabular-nums whitespace-nowrap text-muted-foreground">
                    {formatValue(item.value)}
                  </span>
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      )}
    </li>
  );
}

/** Une limite de plan : son nom, sa remise à zéro, sa part et sa jauge. */
function LimitRow({ row, formatPercent: format }: { row: AgentPlanLimit; formatPercent: (value: number) => string }) {
  const percent = Math.max(0, Math.min(100, row.used * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-body-medium text-foreground">{row.label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {row.resets ? (
            <span className="text-body-regular text-muted-foreground">{row.resets}</span>
          ) : null}
          <span className="min-w-9 text-right text-body-medium tabular-nums whitespace-nowrap text-foreground">
            {format(percent)}
          </span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={row.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-agent-track"
      >
        <div
          className="h-full rounded-full bg-agent-seg-6 transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function AgentLimitsCard({
  budget,
  limits,
  expandLabel,
  collapseLabel,
  freeLabel,
  defaultExpanded = false,
  onExpandedChange,
  formatPercent: formatPercentProp,
  formatLimitPercent: formatLimitPercentProp,
  className,
}: AgentLimitsCardProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const detailId = React.useId();
  const showPercent = formatPercentProp ?? formatPercent;
  const showLimitPercent = formatLimitPercentProp ?? formatLimitPercent;
  if (!budget && !limits) return null;

  const { counted, deferred } = splitSegments(budget?.segments ?? []);
  const used = counted.reduce((sum, segment) => sum + segment.value, 0);
  const free = budget ? Math.max(0, budget.max - used) : 0;
  const format = budget?.formatValue ?? ((value: number) => String(value));
  const showValue = (value: number | null) => (value === null ? DASH : format(value));
  const groups = budget?.groups ?? [];

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section
      className={cn("flex w-full min-w-0 flex-col rounded-2xl bg-surface px-4 pt-2.5 pb-4", className)}
    >
      {budget ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={expanded ? collapseLabel : expandLabel}
            onClick={toggle}
            data-agent-toggle=""
            className="group -mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1 text-left outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-body-medium text-muted-foreground">{budget.label}</span>
            <span className="flex items-center gap-2">
              <span className="text-body-medium whitespace-nowrap tabular-nums text-muted-foreground">
                {budget.readout}{" "}
                <span className="text-foreground">({showPercent(percentOf(used, budget.max))})</span>
              </span>
              <Chevron open={expanded} className="text-muted-foreground/60 group-hover:text-muted-foreground" />
            </span>
          </button>
          <SegmentedBar
            segments={counted}
            max={budget.max}
            label={budget.label}
            formatValue={format}
            className="mt-1.5"
          />
          <Collapsible open={expanded} id={detailId}>
            <ul className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_max-content_max-content] gap-x-2 gap-y-1">
              {counted.map((segment) => (
                <BudgetDetailRow
                  key={segment.label}
                  color={segment.color}
                  label={segment.label}
                  value={format(segment.value)}
                  percent={showPercent(percentOf(segment.value, budget.max))}
                />
              ))}
              {deferred.map((segment) => (
                <BudgetDetailRow
                  key={segment.label}
                  track
                  muted
                  label={segment.label}
                  value={showValue(segment.value)}
                  percent={DASH}
                />
              ))}
              {freeLabel && free > 0 ? (
                <BudgetDetailRow
                  track
                  muted
                  label={freeLabel}
                  value={format(free)}
                  percent={showPercent(percentOf(free, budget.max))}
                />
              ) : null}
            </ul>
            {groups.length > 0 ? (
              <ul className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_max-content_max-content] gap-x-2 gap-y-0.5">
                {groups.map((group) => (
                  <BudgetGroupRow key={group.label} group={group} formatValue={showValue} />
                ))}
              </ul>
            ) : null}
          </Collapsible>
        </>
      ) : null}

      {budget && limits ? <div className="my-3 h-px w-full bg-agent-separator" /> : null}

      {limits ? (
        <>
          {limits.action ? (
            <button
              type="button"
              onClick={limits.action.onClick}
              aria-label={limits.action.label}
              className="group -mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1 text-left outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 truncate text-body-medium text-muted-foreground">{limits.label}</span>
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground motion-reduce:transition-none"
              >
                <path
                  d="M3.5 8h9M8.5 4l4 4-4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-body-medium text-muted-foreground">{limits.label}</span>
            </div>
          )}
          <div className="flex flex-col gap-3 pt-1">
            {limits.rows.map((row) => (
              <LimitRow key={row.id} row={row} formatPercent={showLimitPercent} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * La pastille de contexte qui vit sous le composer : un anneau et un
 * pourcentage. C'est elle qui ouvre la carte.
 */
export function AgentContextMeter({
  percent,
  label,
  readout,
  className,
  textClassName,
}: {
  /**
   * La part consommée, ou `null` quand le plafond est inconnu : l'anneau ne
   * garde alors que sa piste. Un arc à zéro se lirait « rien de consommé »,
   * ce qui est une affirmation, alors qu'on ne sait rien.
   */
  percent: number | null;
  label: string;
  /** Ce qui s'écrit à droite de l'anneau. À défaut, le pourcentage. */
  readout?: string;
  className?: string;
  /** Typography of the readout; defaults to the card's caption. */
  textClassName?: string;
}) {
  const safe = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  // Le rayon vaut 6 sur une boîte de 16 : la circonférence est donc 2πr, et
  // le tiret couvre la part consommée de ce tour.
  const circumference = 2 * Math.PI * 6;
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full bg-surface-hover py-1 pr-2 pl-1.5",
        className,
      )}
      title={label}
    >
      <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" className="shrink-0 -rotate-90">
        {/* Sans arc, la piste EST l'anneau : elle emprunte alors la couleur du
            texte à faible opacité, sinon le cercle disparaît sur un fond déjà
            gris. Avec un arc, elle reprend sa teinte de piste habituelle. */}
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke={percent === null ? "currentColor" : "var(--color-agent-track)"}
          strokeOpacity={percent === null ? 0.45 : 1}
          strokeWidth="2.5"
        />
        {percent === null ? null : (
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(safe / 100) * circumference} ${circumference}`}
          />
        )}
      </svg>
      <span
        className={cn(
          "whitespace-nowrap tabular-nums",
          textClassName ?? "text-caption-1-regular text-muted-foreground",
        )}
      >
        {readout ?? formatPercent(safe)}
      </span>
    </span>
  );
}
