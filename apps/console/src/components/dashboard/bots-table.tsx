import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { stripHandlePrefix } from "@openedbot/roster/domain/ask-user";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { IconAlertTriangle, IconArrowsSort } from "@tabler/icons-react";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openedbot/browser-ui-kit";
import type { BotDto } from "@openedbot/contracts-api";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { Skeleton } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { listTimestamp } from "../../lib/format";
import { BotFace } from "../bot-face";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { useNewBot } from "../../lib/bots/use-new-bot";

const EMPTY_BOTS: BotDto[] = [];

/**
 * Les lignes fantômes de la table pendant le chargement du roster : sans
 * elles, le corps vide affichait « Aucun bot » avant même la réponse : un
 * mensonge d'un quart de seconde. Visage rond puis barres aux largeurs des
 * cinq colonnes réelles (nom, aperçu, modèle, statut, activité).
 */
function BotsTableSkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((index) => (
        <TableRow key={index}>
          <TableCell>
            <div className="flex items-center gap-2">
              <Skeleton className="size-5 shrink-0 rounded-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
            </div>
          </TableCell>
          <TableCell className="w-full max-w-0"><Skeleton className="h-4 w-full motion-reduce:animate-none" /></TableCell>
          <TableCell><Skeleton className="h-3.5 w-28 motion-reduce:animate-none" /></TableCell>
          <TableCell><Skeleton className="h-5 w-20 rounded-full motion-reduce:animate-none" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16 motion-reduce:animate-none" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

/**
 * La table du bloc `dashboard-01`, réduite à ce qu'on a vraiment.
 *
 * Le bloc livre une table avec réordonnancement par glisser-déposer, sélection
 * multiple, pagination, édition en ligne et un tiroir de détail. Rien de tout
 * cela n'a d'objet sur sept lignes qui se cliquent pour ouvrir une
 * conversation : on garde l'en-tête triable et le rendu, on laisse le reste.
 */
export function BotsTable({ flush = false }: { flush?: boolean }) {
  const { t, locale } = useT();
  const createBot = useNewBot();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, retry: false });
  // La colonne « Modèle » nommait le repli « défaut runtime » sans jamais dire
  // DE QUEL modèle il s'agit : deux écrans décrivaient le même état avec des
  // mots différents, et aucun ne donnait la réponse. Le modèle global vient de
  // la même entrée de cache que le bandeau du composer et que l'onglet Modèle
  // d'un bot : trois surfaces, une seule source.
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
  });
  const globalModel = configuration.data?.runtime?.selectedModel ?? null;
  const [sorting, setSorting] = useState<SortingState>([
    { id: "lastActivityAt", desc: true },
  ]);

  const columns = useMemo<ColumnDef<BotDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("botsTable.colBot"),
        cell: ({ row }) => (
          <Link
            to="/bot/$botId"
            params={{ botId: row.original.id }}
            className="flex min-h-11 items-center gap-2 font-medium hover:underline"
          >
            <BotFace
              name={row.original.name}
              seed={row.original.id}
              face={row.original.face}
              className="size-5"
            />
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "preview",
        header: t("botsTable.colLastMessage"),
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground">
            {row.original.preview ? stripHandlePrefix(row.original.preview, roster.data?.operator ?? null) : t("botsTable.newConversation")}
          </span>
        ),
      },
      {
        accessorKey: "model",
        header: t("botsTable.colModel"),
        cell: ({ row }) => {
          // Modèle propre au bot : il s'affiche seul. Sinon le modèle global
          // RÉSOLU, marqué comme tel : la distinction « le sien » / « celui de
          // tout le monde » reste lisible sans cacher la valeur effective.
          // Global inconnu (runtime injoignable, cache froid) : le libellé
          // seul, qui reste vrai.
          if (row.original.model !== null) {
            return <span className="font-mono text-xs text-muted-foreground">{row.original.model}</span>;
          }
          if (globalModel === null) {
            return <span className="font-mono text-xs text-muted-foreground">{t("botsTable.runtimeDefault")}</span>;
          }
          return (
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-xs text-muted-foreground">{globalModel}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {t("botsTable.modelGlobalSuffix")}
              </span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: t("botsTable.colStatus"),
        cell: ({ row }) =>
          row.original.awaitingApproval ? (
            <Badge variant="destructive">
              <IconAlertTriangle />
              {t("botsTable.decisionRequired")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("botsTable.atRest")}</Badge>
          ),
      },
      {
        accessorKey: "lastActivityAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            {t("botsTable.colActivity")}
            <IconArrowsSort className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {listTimestamp(row.original.lastActivityAt, undefined, locale)}
          </span>
        ),
      },
    ],
    // `operator` : la cellule d'aperçu nettoie le préfixe protocole avec le
    // handle réel : sans cette dépendance, la closure gardait le roster du
    // premier rendu (data absente) et `@elodie` restait affiché.
    [t, locale, roster.data?.operator, globalModel],
  );

  // `data` must keep the same reference between renders: TanStack Table
  // treats a new array as new data, resets its page index in a microtask,
  // which re-renders the component, which builds a new array again : an
  // infinite render loop that froze /settings/models on an empty roster.
  const data = useMemo(
    () => visibleRosterItems(roster.data?.bots ?? EMPTY_BOTS).filter((bot) => bot.archivedAt == null),
    [roster.data?.bots],
  );
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className={flush ? undefined : "px-4 lg:px-6"}>
      {roster.isError && <div role={roster.data ? "status" : "alert"} className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
        <span>{roster.data ? t("botsTable.stale", { date: new Date(roster.dataUpdatedAt).toLocaleString(locale) }) : t("botsTable.unavailable")}</span>
        <button type="button" className={BUTTON.small} onClick={() => void roster.refetch()}>{t("common.retry")}</button>
      </div>}
      {/* Pendant le chargement, c'est le cadre entier qui annonce l'attente :
          les lignes fantômes sont dans le corps, l'en-tête reste le vrai. */}
      <div
        className="overflow-hidden rounded-lg border"
        {...(roster.isPending ? { role: "status", "aria-label": t("common.loading") } : {})}
      >
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={header.column.id === "preview" ? "w-full" : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {roster.isPending ? (
              <BotsTableSkeletonRows />
            ) : roster.isError && !roster.data ? null
              : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {/* Shown in Settings › Activité, whose sidebar is the settings
                      nav: the « + » of the bot list is not on screen there. */}
                  <div className="flex flex-col items-center gap-3">
                    <span>{t("botsTable.empty")}</span>
                    <button type="button" className={BUTTON.soft} onClick={() => createBot()}>
                      {t("botsTable.create")}
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cell.column.id === "preview" ? "w-full max-w-0" : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
