import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Skeleton,
  cn,
} from "@openedbot/browser-ui-kit";

/**
 * Les silhouettes d'Activité (`/settings`), hors du chunk des graphiques : le
 * repli de la rubrique (`settings-skeletons.tsx`), le cadre pendant les gardes
 * (`AppFrameSkeleton`) et les blocs pas encore montés d'`OverviewDashboard`
 * dessinent la même chose, donc rien ne bouge d'une étape à l'autre.
 *
 * Chaque silhouette reprend les composants de la vraie carte (`Card`,
 * `CardHeader`, `Badge`…) et pose les barres dans des lignes de texte de la
 * même classe : la hauteur vient des mêmes `line-height` et des mêmes
 * marges, au lieu d'une hauteur fixée à la main qui dérivait de 12 px (une
 * tuile faisait 128 px en chargement, 140 px chargée) et suivait mal la
 * taille du texte.
 */

/**
 * Sur une carte, le gris des barres monte d'un cran (convention de
 * `skeleton.tsx`) : en sombre, `--muted` vaut le fond de `bg-card` et les
 * barres disparaissaient.
 */
const ON_CARD = "[--skeleton:var(--muted)] dark:[--skeleton:#404040]";

/** Une barre qui pulse à l'intérieur d'une ligne de texte, sans en changer la hauteur. */
function TextBar({ className }: { className: string }) {
  return <Skeleton className={cn("inline-block align-middle motion-reduce:animate-none", className)} />;
}

/** La grille des quatre tuiles de `SectionCards`, mêmes classes. */
const SECTION_CARDS_GRID =
  "grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card";

export function SectionCardsSkeleton({ label, flush }: { label: string; flush?: boolean }) {
  return (
    <div className="space-y-2">
      <div role="status" aria-label={label} className={cn(SECTION_CARDS_GRID, !flush && "px-4 lg:px-6")}>
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className={cn("@container/card [--card-spacing:--spacing(4)]", ON_CARD)}>
            <CardHeader>
              <CardDescription className="text-xs"><TextBar className="h-3 w-24" /></CardDescription>
              <CardTitle className="text-xl font-semibold @[250px]/card:text-2xl"><TextBar className="h-6 w-12" /></CardTitle>
              <CardAction>
                <Badge variant="outline"><TextBar className="h-3 w-16" /></Badge>
              </CardAction>
            </CardHeader>
            <CardFooter className="flex-col items-start gap-0.5 text-xs">
              <div><TextBar className="h-3 w-40" /></div>
              <div><TextBar className="h-3 w-28" /></div>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

/**
 * Le tracé à sa hauteur définitive (250 px) et la rangée de graduations : le
 * contenu d'une carte de graphique pendant que ses données arrivent.
 */
export function ChartPlotSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className={cn("flex h-[250px] w-full flex-col gap-2", ON_CARD)}>
      <Skeleton className="min-h-0 w-full flex-1 motion-reduce:animate-none" />
      <div className="flex justify-between px-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <Skeleton key={index} className="h-3 w-10 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * Une carte de graphique entière (activité ou jetons) avant que son module ne
 * soit monté : titre, description, sélecteur de période et tracé. `totalLine`
 * : la carte des jetons porte une ligne de total sous sa description.
 */
export function ChartCardSkeleton({ label, totalLine = false }: { label: string; totalLine?: boolean }) {
  return (
    <Card className={cn("@container/card", ON_CARD)}>
      <CardHeader>
        <CardTitle><Skeleton className="h-3.5 w-32 motion-reduce:animate-none" /></CardTitle>
        <CardDescription>
          {/* Des barres en bloc, à la hauteur des lignes (titre de 14 px,
              lignes de description de 20 px) : centrée dans le texte, une barre
              gonflait sa ligne de 2 px. */}
          <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-56 motion-reduce:animate-none" /></span>
          {totalLine ? <span className="flex h-5 items-center"><Skeleton className="h-3.5 w-40 motion-reduce:animate-none" /></span> : null}
        </CardDescription>
        <CardAction>
          <Skeleton className="hidden h-9 w-72 rounded-md motion-reduce:animate-none @[767px]/card:block" />
          <Skeleton className="h-9 w-40 rounded-md motion-reduce:animate-none @[767px]/card:hidden" />
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartPlotSkeleton label={label} />
      </CardContent>
    </Card>
  );
}

/** Le haut d'Activité : tuiles puis les deux graphiques, comme `OverviewDashboard` (`flush`). */
export function OverviewDashboardSkeleton({ label }: { label: string }) {
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <SectionCardsSkeleton label={label} flush />
      <div className="grid grid-cols-1 gap-4 md:gap-6 @5xl/main:grid-cols-2">
        <ChartCardSkeleton label={label} />
        <ChartCardSkeleton label={label} totalLine />
      </div>
    </div>
  );
}
