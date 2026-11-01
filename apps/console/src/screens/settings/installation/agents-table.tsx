import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { IconArrowsSort, IconSearch } from "@tabler/icons-react";
import type { RuntimeHostProfileDto } from "@openedbot/contracts-api";
import { Button, Checkbox, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openedbot/browser-ui-kit";
import { ALIVE_BADGE, BUTTON, ToneBadge } from "../../../components/settings/primitives";
import { useT } from "../../../lib/i18n";

function canImportProfile(profile: RuntimeHostProfileDto): boolean {
  return !profile.alreadyImported && !profile.hidden;
}

function importRank(profile: RuntimeHostProfileDto): number {
  if (canImportProfile(profile)) return 0;
  if (profile.hidden && !profile.alreadyImported) return 1;
  return 2;
}

/**
 * Inventaire des profils hôte en DataTable, sur bureau.
 *
 * Une colonne par fait : sélection, nom, état, modèle, routines, action.
 * Le tri par défaut met les importables en tête. `profiles` doit garder sa
 * référence entre deux rendus (TanStack Table re-rend en boucle sur un tableau neuf).
 */
export function HostProfilesTable({
  profiles,
  selected,
  onToggle,
  onToggleAll,
  canDelete,
  onDelete,
  onDeleteSelected,
  deleting,
  deletingSlugs,
  importAction,
}: {
  profiles: RuntimeHostProfileDto[];
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
  onToggleAll: (slugs: string[], checked: boolean) => void;
  canDelete: boolean;
  onDelete: (profile: RuntimeHostProfileDto) => void;
  onDeleteSelected: () => void;
  deleting: boolean;
  deletingSlugs: ReadonlySet<string>;
  importAction: ReactNode;
}) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "rank", desc: false },
    { id: "name", desc: false },
  ]);
  const sortBy = (id: "name" | "model" | "routines") =>
    setSorting((previous) => [
      { id: "rank", desc: false },
      { id, desc: previous[1]?.id === id ? !previous[1].desc : false },
    ]);

  const columns = useMemo<ColumnDef<RuntimeHostProfileDto>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        cell: ({ row }) => {
          const importable = canImportProfile(row.original);
          if (!importable) {
            return <span className="block w-4" aria-hidden />;
          }
          return (
            <Checkbox
              checked={selected.has(row.original.name)}
              onCheckedChange={() => onToggle(row.original.name)}
              aria-label={t("profileImport.selectRow", { name: row.original.displayName })}
              onClick={(event) => event.stopPropagation()}
            />
          );
        },
      },
      {
        id: "rank",
        accessorFn: importRank,
        enableHiding: true,
        header: () => null,
        cell: () => null,
      },
      {
        id: "name",
        accessorFn: (profile) => profile.displayName,
        header: () => (
          <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={() => sortBy("name")}>
            {t("profileImport.colName")}
            <IconArrowsSort className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="min-w-0">
            <span className="block truncate font-medium">{row.original.displayName}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">{row.original.name}</span>
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (profile) => (profile.alreadyImported ? "roster" : profile.hidden ? "hidden" : "import"),
        header: t("profileImport.colStatus"),
        cell: ({ row }) => {
          if (row.original.alreadyImported) {
            return <ToneBadge tone="info" className="whitespace-nowrap">{t("profileImport.inRoster")}</ToneBadge>;
          }
          if (row.original.hidden) {
            return <ToneBadge tone="neutral" className="whitespace-nowrap">{t("profileImport.hidden")}</ToneBadge>;
          }
          return (
            <ToneBadge tone="success" className={cn("whitespace-nowrap", ALIVE_BADGE)}>
              {t("profileImport.toImport")}
            </ToneBadge>
          );
        },
      },
      {
        id: "model",
        accessorFn: (profile) => profile.model.default ?? "",
        header: () => (
          <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={() => sortBy("model")}>
            {t("profileImport.colModel")}
            <IconArrowsSort className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.model.default ?? t("profileImport.modelUnknown")}
          </span>
        ),
      },
      {
        id: "routines",
        accessorFn: (profile) => profile.routineCount,
        header: () => (
          <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={() => sortBy("routines")}>
            {t("profileImport.colRoutines")}
            <IconArrowsSort className="size-3.5" />
          </Button>
        ),
        cell: ({ row }) => row.original.routines.length === 0 ? (
          <span className="tabular-nums text-muted-foreground">0</span>
        ) : (
          <details>
            <summary className="cursor-pointer tabular-nums text-muted-foreground">
              {row.original.routineCount}
            </summary>
            <ul className="mt-1 min-w-56 space-y-1 text-xs text-muted-foreground">
              {row.original.routines.map((routine) => (
                <li key={`${routine.name}:${routine.schedule}`}>
                  <span className="font-medium text-foreground">{routine.name}</span>
                  <span className="block font-mono">{routine.schedule}</span>
                  <span className="block truncate" title={routine.prompt}>{routine.prompt}</span>
                  {!routine.enabled ? ` · ${t("profileImport.routinePaused")}` : null}
                  {!routine.deliver ? ` · ${t("profileImport.routineNoDelivery")}` : null}
                </li>
              ))}
            </ul>
          </details>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{t("profileImport.colActions")}</span>,
        cell: ({ row }) => {
          if (!canDelete) return null;
          return (
            <span className="flex justify-end">
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={deleting || selected.size >= 2 || deletingSlugs.has(row.original.name)}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(row.original);
                }}
              >
                {t("profileImport.deleteHost")}
              </Button>
            </span>
          );
        },
      },
    ],
    [t, selected, onToggle, canDelete, onDelete, deleting, deletingSlugs],
  );

  const table = useReactTable({
    data: profiles,
    columns,
    state: { sorting, globalFilter: search, columnVisibility: { rank: false } },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row, _columnId, value: string) => {
      const needle = value.trim().toLowerCase();
      if (!needle) return true;
      const profile = row.original;
      return `${profile.displayName} ${profile.name} ${profile.model.default ?? ""} ${profile.description ?? ""}`
        .toLowerCase()
        .includes(needle);
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (profile) => profile.name,
  });
  const rows = table.getRowModel().rows;
  const visibleImportable = rows.map((row) => row.original).filter(canImportProfile);
  const allVisibleSelected =
    visibleImportable.length > 0 && visibleImportable.every((profile) => selected.has(profile.name));
  const someVisibleSelected = visibleImportable.some((profile) => selected.has(profile.name));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <IconSearch aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("profileImport.searchPlaceholder")}
            aria-label={t("profileImport.searchPlaceholder")}
            className="pl-9"
          />
        </div>
        {importAction}
        {canDelete && selected.size >= 2 ? (
          <button type="button" disabled={deleting} onClick={onDeleteSelected} className={BUTTON.danger}>
            {t("profileImport.deleteSelected", { count: String(selected.size) })}
          </button>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader className="bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn("px-3", header.id === "select" && "w-10", header.id === "actions" && "w-[1%]")}
                  >
                    {header.id === "select" ? (
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                        disabled={visibleImportable.length === 0}
                        onCheckedChange={(value) =>
                          onToggleAll(visibleImportable.map((profile) => profile.name), value === true)
                        }
                        aria-label={t("profileImport.selectAll")}
                      />
                    ) : header.isPlaceholder ? null : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="px-3 py-8 text-center text-muted-foreground">
                  {t("profileImport.searchEmpty")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const importable = canImportProfile(row.original);
                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      importable && "cursor-pointer",
                      row.original.alreadyImported && "bg-surface-sunken/40",
                      deletingSlugs.has(row.original.name) && "opacity-60",
                    )}
                    onClick={importable ? () => onToggle(row.original.name) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="px-3 py-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
