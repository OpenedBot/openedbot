import { cn } from "@openedbot/browser-ui-kit";
import { SETTINGS_PANEL } from "../../../../components/settings/primitives";

const BAR = "animate-pulse rounded bg-muted motion-reduce:animate-none";

/** Une ligne de connecteur : logo, nom, description, pilule d'action. */
function RowSkeleton() {
  return (
    <li aria-hidden className="flex min-w-0 items-center gap-3 py-3">
      <span className={cn(BAR, "size-8 shrink-0 rounded-lg")} />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className={cn(BAR, "block h-3.5 w-24")} />
        <span className={cn(BAR, "block h-3 w-48 max-w-full")} />
      </span>
      <span className={cn(BAR, "h-7 w-16 shrink-0 rounded-full")} />
    </li>
  );
}

/**
 * Une section comme `McpConnectorSection` : un titre, puis une carte de
 * lignes, sur deux colonnes dès que le conteneur le permet.
 */
function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="@container space-y-2">
      <div className={cn(BAR, "mx-1 h-4 w-28")} />
      {/* Les filets de `CONNECTOR_CARD_GRID` : aucun au-dessus de la première
          ligne, ni de la deuxième sur deux colonnes. */}
      <ul
        className={cn(
          SETTINGS_PANEL,
          "grid grid-cols-1 overflow-hidden px-4 @xl:grid-cols-2 @xl:gap-x-8",
          "[&>li]:border-t [&>li]:border-border/60 [&>li:first-child]:border-t-0 @xl:[&>li:nth-child(2)]:border-t-0",
        )}
      >
        {Array.from({ length: rows }, (_, index) => <RowSkeleton key={index} />)}
      </ul>
    </div>
  );
}

/**
 * L'ossature de Connecteurs au bureau pendant la première lecture : la même
 * charpente que `ConnectorsDesktop` (onglets, recherche, « Nouveau
 * connecteur », sections de lignes), pour que rien ne saute quand
 * l'inventaire arrive. Trois grandes cartes vides annonçaient une autre page.
 */
export function ConnectorsDesktopSkeleton({ label }: { label: string }) {
  return (
    <div data-connectors-layout="desktop-skeleton" className="space-y-6" role="status" aria-label={label}>
      <div aria-hidden className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {["w-28", "w-28", "w-16"].map((width, index) => (
            <span key={index} className={cn(BAR, "h-9 rounded-full", width)} />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className={cn(BAR, "h-9 w-full max-w-64 rounded-full")} />
          <span className={cn(BAR, "h-9 w-44 shrink-0 rounded-full")} />
        </div>
      </div>
      <div aria-hidden className="space-y-8">
        <SectionSkeleton rows={1} />
        <SectionSkeleton rows={4} />
        <SectionSkeleton rows={2} />
      </div>
    </div>
  );
}
