import { useState, type ReactNode } from "react";
import { Checkbox, cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { BUTTON, CardHeading, SettingsCard } from "../../../components/settings/primitives";
import { DataTablePagination } from "../../../components/boardui/data-table";
import { useT } from "../../../lib/i18n";

/** Lignes d'une section des archives par page. */
export const ARCHIVE_PAGE_SIZE = 15;

/** La page affichée, ramenée dans les bornes quand la liste rétrécit, et ses lignes. */
export function archivePage<T>(items: readonly T[], page: number): { page: number; pages: number; start: number; rows: T[] } {
  const pages = Math.max(1, Math.ceil(items.length / ARCHIVE_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const start = current * ARCHIVE_PAGE_SIZE;
  return { page: current, pages, start, rows: items.slice(start, start + ARCHIVE_PAGE_SIZE) };
}

/** L'état de la case « cette page » : rien, une partie (`indeterminate`) ou tout. */
export function pageCheckState(pageKeys: readonly string[], picked: ReadonlySet<string>): boolean | "indeterminate" {
  const count = pageKeys.filter((key) => picked.has(key)).length;
  if (count === 0) return false;
  return count === pageKeys.length ? true : "indeterminate";
}

/**
 * Une section des archives (corbeille, bots archivés, conversations
 * masquées) : son titre, ses lignes par pages de 15, et une sélection qui
 * survit au changement de page. La case de l'en-tête coche la page ; « Tout
 * sélectionner » prend toute la section. Les gestes de masse (`actions`)
 * reçoivent la sélection. Une entrée qui quitte la section (restaurée,
 * effacée) sort de la sélection d'elle-même ; un échec y reste, pour réessayer.
 */
export function ArchiveSection<T>({
  title,
  description,
  items,
  keyOf,
  labelOf,
  renderRow,
  actions,
  busy = false,
}: {
  title: string;
  description: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Le nom lu par un lecteur d'écran sur la case de la ligne. */
  labelOf: (item: T) => string;
  renderRow: (item: T, select: ReactNode) => ReactNode;
  actions: (selected: T[]) => ReactNode;
  /** Un geste de masse en cours : la sélection ne change plus sous lui. */
  busy?: boolean;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const view = archivePage(items, page);
  const selected = items.filter((item) => picked.has(keyOf(item)));
  const pageKeys = view.rows.map(keyOf);
  const pageState = pageCheckState(pageKeys, picked);

  const setKeys = (keys: readonly string[], on: boolean) => setPicked((previous) => {
    const next = new Set(previous);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    return next;
  });

  return (
    <SettingsCard padded={false} className={cn("overflow-hidden", isMobile ? "py-1" : "p-0")}>
      <div className={isMobile ? "px-4 pt-3 pb-1" : "px-4 pt-4"}>
        <CardHeading title={title} description={description} />
      </div>
      <div data-archive-toolbar="" className="mt-2 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          <Checkbox
            checked={pageState}
            disabled={busy}
            onCheckedChange={() => setKeys(pageKeys, pageState !== true)}
            aria-label={t("settingsArchives.selectPage")}
          />
          {selected.length > 0
            ? <span className="tabular-nums text-foreground">{t("settingsArchives.selectedCount", { count: selected.length, total: items.length })}</span>
            : <span>{t("settingsArchives.selectPage")}</span>}
        </label>
        {selected.length < items.length && items.length > view.rows.length ? (
          <button type="button" className={BUTTON.small} disabled={busy} onClick={() => setKeys(items.map(keyOf), true)}>
            {t("settingsArchives.selectAll", { count: items.length })}
          </button>
        ) : null}
        {selected.length > 0 ? (
          <button type="button" className={BUTTON.small} disabled={busy} onClick={() => setPicked(new Set())}>
            {t("settingsArchives.clearSelection")}
          </button>
        ) : null}
        {selected.length > 0 ? (
          <span className="ms-auto flex flex-wrap items-center gap-2 max-sm:w-full max-sm:justify-end">{actions(selected)}</span>
        ) : null}
      </div>
      <ul className={isMobile ? "divide-y divide-border/40" : "divide-y divide-border"}>
        {view.rows.map((item) => {
          const key = keyOf(item);
          return renderRow(item, (
            <Checkbox
              checked={picked.has(key)}
              disabled={busy}
              onCheckedChange={(checked) => setKeys([key], checked === true)}
              aria-label={t("settingsArchives.selectRow", { name: labelOf(item) })}
            />
          ));
        })}
      </ul>
      {view.pages > 1 ? (
        <div data-archive-pagination="" className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2">
          <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {t("settingsArchives.paginationRange", { from: view.start + 1, to: view.start + view.rows.length, total: items.length })}
          </p>
          <DataTablePagination
            page={view.page}
            pages={view.pages}
            onPage={setPage}
            label={t("settingsArchives.paginationLabel", { title })}
            previousLabel={t("settingsArchives.paginationPrevious")}
            nextLabel={t("settingsArchives.paginationNext")}
            pageLabel={(index) => t("settingsArchives.paginationPage", { page: index + 1 })}
          />
        </div>
      ) : null}
    </SettingsCard>
  );
}
