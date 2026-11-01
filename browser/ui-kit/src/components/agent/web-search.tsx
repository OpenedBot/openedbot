import * as React from "react";
import { cn } from "../../lib/utils";
import { Reveal } from "./reveal";
import { AgentThinking } from "./agent-thinking";
import { Branch, Stem, TRUNK_LEFT } from "./connectors";

/**
 * La trace d'une recherche web. Porté du bloc `web-search` de BoardUI : une
 * tête qui dit combien de recherches ont tourné, sous elle chaque requête
 * avec son compte de résultats, et sous chaque requête ses sources en pile
 * de marques qu'un clic déplie.
 *
 * Les sources viennent de `projectWebSearches`, relu du transcript du run.
 * Une requête sans source lue reste affichée : la recherche a bien eu lieu.
 *
 * Le bloc tient les MÊMES colonnes que le journal de tâches voisin, qui se
 * lit juste au-dessus ou au-dessous dans le fil : glyphe de tête sur 16 px,
 * titre à 24 px, tronc à `TRUNK_LEFT`, rangée indentée de `pl-4` depuis le
 * tronc. Les deux blocs doivent rester superposables ; une valeur choisie à
 * l'œil ici décale toute la trace par rapport au reste du fil.
 */

export type WebSearchSourceView = {
  title: string;
  url: string;
  domain: string;
  description?: string | null;
};

export type WebSearchQueryView = {
  id: string;
  query: string;
  sources: WebSearchSourceView[];
  /** Le libellé du compte, déjà mis au pluriel par l'appelant. */
  resultLabel?: string | null;
  /** Le message du fournisseur quand la recherche a échoué. */
  error?: string | null;
  /** La requête est encore en vol. */
  running?: boolean;
};

/** Au-delà, la pile de marques compte le reste au lieu de l'empiler. */
const MAX_MARKS = 5;
const STEP_STAGGER_MS = 90;

/**
 * La marque d'un site : sa première lettre dans un disque, teintée par le
 * domaine. Le logo réel demanderait une requête vers le site lui-même, ce
 * qu'un fil de conversation n'a pas à déclencher.
 */
function SiteMark({ domain, index }: { domain: string; index: number }) {
  return (
    <span
      className="relative flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[9px] font-medium uppercase text-muted-foreground"
      style={{ zIndex: MAX_MARKS - index }}
      title={domain}
    >
      {domain.slice(0, 1)}
    </span>
  );
}

function SourcesRow({
  sources,
  label,
  expandLabel,
}: {
  sources: WebSearchSourceView[];
  label: string;
  expandLabel: string;
}) {
  const [open, setOpen] = React.useState(false);
  const marks = sources.slice(0, MAX_MARKS);
  const rest = sources.length - marks.length;

  return (
    <li className="relative overflow-hidden pl-4">
      <Branch last />
      <div className="py-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={expandLabel}
          onClick={() => setOpen((previous) => !previous)}
          data-agent-toggle=""
          className="group flex cursor-pointer items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-body-regular text-muted-foreground">{label}</span>
          <span className="ml-2 flex items-center">
            <span className="flex items-center -space-x-1.5">
              {marks.map((source, index) => (
                <SiteMark key={source.url} domain={source.domain} index={index} />
              ))}
            </span>
            {rest > 0 ? (
              <span className="ml-1.5 shrink-0 text-body-regular tabular-nums text-muted-foreground/80">
                +{rest}
              </span>
            ) : null}
          </span>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={cn(
              "ml-1 size-4 shrink-0 text-muted-foreground/60 transition-transform duration-300 ease-out group-hover:text-muted-foreground",
              open && "rotate-180",
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
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        >
          <div className="min-h-0 overflow-hidden">
            <ul className="flex flex-col">
              {sources.map((source) => (
                <li key={source.url}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors duration-150 ease-out hover:bg-surface"
                  >
                    <SiteMark domain={source.domain} index={0} />
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="min-w-0 truncate text-body-regular text-foreground">
                        {source.title}
                      </span>
                      <span className="shrink-0 text-caption-1-regular text-muted-foreground/80">
                        {source.domain}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </li>
  );
}

function QueryRow({
  query,
  last,
  sourcesLabel,
  sourcesExpandLabel,
}: {
  query: WebSearchQueryView;
  last: boolean;
  sourcesLabel: string;
  sourcesExpandLabel: string;
}) {
  return (
    <li className="relative overflow-hidden pl-4">
      <Branch last={last} />
      <div className="py-1">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-body-regular text-muted-foreground">
            <span className={query.running ? "ohb-agent-label" : undefined}>{query.query}</span>
          </p>
          {query.resultLabel ? (
            <span className="shrink-0 pt-px text-body-regular tabular-nums text-muted-foreground/80">
              {query.resultLabel}
            </span>
          ) : null}
        </div>
        {query.error ? (
          <p className="mt-0.5 text-caption-1-regular text-destructive-text">{query.error}</p>
        ) : null}
        {query.sources.length > 0 ? (
          <div className="relative mt-0.5">
            <Stem height={5} />
            <ul className="flex flex-col" style={{ marginLeft: TRUNK_LEFT }}>
              <SourcesRow
                sources={query.sources}
                label={sourcesLabel}
                expandLabel={sourcesExpandLabel}
              />
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export type WebSearchProps = {
  /** La tête du bloc, « 3 recherches jouées ». */
  title: string;
  /**
   * Le glyphe de tête, à gauche du titre, comme celui d'une tâche du journal
   * d'outils. Il tient la gouttière : c'est lui qui pose le titre sur la même
   * colonne que les rangées de l'arbre, et le tronc sous son centre. Sans lui
   * le titre revient au bord du bloc et l'arbre pend à sa droite.
   */
  icon?: React.ReactNode;
  queries: WebSearchQueryView[];
  sourcesLabel: string;
  sourcesExpandLabel: string;
  /** Posé, l'indicateur de travail suit la queue de la trace. */
  working?: { label: string; startedAt?: string | null } | null;
  /**
   * Replie la trace à l'ouverture. Le fil le pose quand le tour est conclu :
   * une recherche déjà répondue est un chemin parcouru, pas une information à
   * relire, et trois requêtes dépliées repoussaient la réponse hors de l'écran.
   * L'opérateur garde la main : son clic prime ensuite sur ce défaut.
   */
  defaultCollapsed?: boolean;
  /** Le libellé du bouton de tête, pour un lecteur d'écran. */
  toggleLabel?: string;
  className?: string;
};

export function WebSearch({
  title,
  icon,
  queries,
  sourcesLabel,
  sourcesExpandLabel,
  working = null,
  defaultCollapsed = false,
  toggleLabel,
  className,
}: WebSearchProps) {
  // Une recherche qui tourne encore ne se replie pas : le `working` est
  // précisément ce qu'on regarde. Le repli ne vaut que pour une trace conclue.
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed && !working);
  // Même transition de hauteur que le journal d'outils voisin : les deux blocs
  // se plient de la même façon, sinon le fil sautille d'un bloc à l'autre.
  const animate = !defaultCollapsed;
  return (
    <div className={cn("flex w-full flex-col", className)}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={toggleLabel}
        onClick={() => setCollapsed(!collapsed)}
        data-agent-toggle=""
        // `w-fit` : la flèche suit le dernier mot du titre. En pleine largeur
        // avec un titre en `flex-1`, elle partait au bord droit du fil, à des
        // centaines de pixels du texte qu'elle déplie.
        className="group flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {icon ? (
          <span
            aria-hidden
            // Masque le tronc de la trace du tour qui passe sous le glyphe, à la
            // couleur de la surface du fil (`--agent-glyph-mask`, posé par
            // l’hôte ; repli : `--color-background`).
            className="relative flex size-4 shrink-0 items-center justify-center bg-[var(--agent-glyph-mask,var(--color-background))] text-muted-foreground"
          >
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-body-regular text-muted-foreground">{title}</span>
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
          <div className="relative">
            <Stem height={6} />
            <div style={{ marginLeft: TRUNK_LEFT }}>
              <ul aria-live="polite" className="flex flex-col">
                {queries.map((query, index) => (
                  <Reveal key={query.id} delayMs={animate ? index * STEP_STAGGER_MS : 0} instant={!animate}>
                    <QueryRow
                      query={query}
                      last={index === queries.length - 1 && !working}
                      sourcesLabel={sourcesLabel}
                      sourcesExpandLabel={sourcesExpandLabel}
                    />
                  </Reveal>
                ))}
              </ul>
            </div>
          </div>
          {working ? (
            <AgentThinking
              variant="infinity"
              label={working.label}
              startedAt={working.startedAt ?? null}
              className="pt-0.5"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
