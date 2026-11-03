import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { MCP_CONNECTOR_MARKS } from "./mcp-connector-marks";
import { SETTINGS_PANEL } from "./settings/primitives";

/**
 * La ligne d'un connecteur, partagée par Réglages › Connecteurs et par le
 * volet MCP d'un bot : logo carré de 32 px, nom, une ligne de description
 * atténuée, et le geste à droite. La carte, quand il y en a une, est celle de
 * la section (`McpConnectorSection`).
 */

/** Le pilule « Ajouter » / « Connecter » : discret, mais un vrai bouton. */
export const CONNECTOR_PILL =
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-card px-3 text-xs font-medium text-foreground shadow-[var(--shadow-xs)] outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Le logo d'un connecteur. Une marque connue se peint dans sa couleur sur une
 * tuile claire, dans les deux thèmes (une marque noire sur fond sombre
 * disparaîtrait) ; une marque inconnue prend l'initiale de son nom.
 */
/**
 * L'initiale d'un nom : sa première lettre ou son premier chiffre. Un nom qui
 * commence par un emoji (« 👁️ Vision ») ne doit pas rendre une moitié de paire
 * UTF-16 ; sans lettre du tout, le premier graphème entier.
 */
export function connectorInitial(name: string): string {
  const trimmed = name.trim();
  const letter = /[\p{L}\p{N}]/u.exec(trimmed);
  if (letter) return letter[0];
  return Array.from(trimmed)[0] ?? "?";
}

export function McpConnectorLogo({ id, name, className }: { id: string; name: string; className?: string }) {
  const mark = MCP_CONNECTOR_MARKS[id];
  if (!mark) {
    return (
      <span
        aria-hidden
        data-connector-logo="letter"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold uppercase text-muted-foreground ring-1 ring-border",
          className,
        )}
      >
        {connectorInitial(name)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-connector-logo={id}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-black/10 dark:ring-white/10", className)}
    >
      <svg viewBox="0 0 24 24" className="size-[18px]" fill={mark.hex} focusable="false">
        <path d={mark.path} />
      </svg>
    </span>
  );
}

export function McpConnectorRow({
  logo,
  name,
  description,
  caption,
  action,
  onOpen,
  openLabel,
}: {
  logo: ReactNode;
  name: string;
  description?: ReactNode;
  /** Une seconde ligne courte, quand l'état demande une explication. */
  caption?: ReactNode;
  action?: ReactNode;
  /** La ligne s'ouvre (détail) : le nom et la description deviennent un bouton. */
  onOpen?: () => void;
  openLabel?: string;
}) {
  const body = (
    <>
      {logo}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
        {caption ? <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{caption}</span> : null}
      </span>
    </>
  );
  return (
    <li data-connector-row="" className="flex min-w-0 items-center gap-3 py-3">
      {onOpen ? (
        <button
          type="button"
          aria-label={openLabel}
          onClick={onOpen}
          className="-mx-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {action ? <span className="flex shrink-0 items-center gap-2">{action}</span> : null}
    </li>
  );
}

/** La grille des lignes : une colonne, deux dès que le conteneur `@container` le permet. */
export const CONNECTOR_GRID = "grid grid-cols-1 gap-x-8 @xl:grid-cols-2";

/**
 * La même grille, posée dans une carte : les lignes prennent la marge de la
 * carte et un filet les sépare, sur toute la largeur. Sur deux colonnes, les
 * deux premières lignes n'ont pas de filet au-dessus.
 */
const CONNECTOR_CARD_GRID = cn(
  SETTINGS_PANEL,
  "grid grid-cols-1 overflow-hidden px-4 @xl:grid-cols-2 @xl:gap-x-8",
  "[&>li]:border-t [&>li]:border-border/60 [&>li:first-child]:border-t-0 @xl:[&>li:nth-child(2)]:border-t-0",
);

/**
 * Une section : un titre au-dessus, puis une carte claire (comme les groupes
 * de Mon compte, sans le fond neutre qui les entoure) qui porte la liste sur
 * DEUX colonnes dès que le panneau est assez large. La largeur se lit sur le
 * conteneur, pas sur la fenêtre : la même page vit dans la modale des réglages
 * et en pleine page.
 */
export function McpConnectorSection({
  title,
  description,
  action,
  footer,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Ce qui n'est pas une ligne (une note, une erreur), sous la carte. */
  footer?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section aria-labelledby={id} className="@container space-y-2">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
          {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <ul className={CONNECTOR_CARD_GRID}>{children}</ul>
      {footer}
    </section>
  );
}
