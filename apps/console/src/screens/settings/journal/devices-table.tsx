import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { IconArrowsSort, IconDeviceLaptop, IconDeviceMobile } from "@tabler/icons-react";
import { describeUserAgent } from "@/lib/platform/user-agent";
import type { AccountSessionDto } from "@openedbot/contracts-api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from "@openedbot/browser-ui-kit";
import { BUTTON, ToneBadge } from "../../../components/settings/primitives";
import { formatDate as formatDateI18n } from "@openedbot/browser-i18n";
import { formatDate } from "../../../lib/format";
import type { useT } from "../../../lib/i18n";

type T = ReturnType<typeof useT>["t"];
type Locale = ReturnType<typeof useT>["locale"];

/** Classic DataTable page: short enough to read a session, long enough for the history. */
const PAGE_SIZE = 10;

function pageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index);
  const windowStart = Math.max(1, current - 1);
  const windowEnd = Math.min(total - 2, current + 1);
  const items: Array<number | "ellipsis"> = [0];
  if (windowStart > 1) items.push("ellipsis");
  for (let index = windowStart; index <= windowEnd; index += 1) items.push(index);
  if (windowEnd < total - 2) items.push("ellipsis");
  items.push(total - 1);
  return items;
}

function DevicesPagination({
  pageIndex,
  pageCount,
  from,
  to,
  total,
  onPageChange,
  t,
}: {
  pageIndex: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  onPageChange: (pageIndex: number) => void;
  t: T;
}) {
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("settingsSecurity.paginationRange", { from, to, total })}
      </p>
      {pageCount > 1 ? (
        <nav aria-label={t("settingsSecurity.paginationLabel")} className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={BUTTON.small}
            disabled={pageIndex === 0}
            onClick={() => onPageChange(pageIndex - 1)}
          >
            {t("settingsSecurity.paginationPrevious")}
          </button>
          {pageItems(pageIndex, pageCount).map((item, index) =>
            item === "ellipsis" ? (
              <span key={`ellipsis-${index}`} className="px-1.5 text-xs text-muted-foreground" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                className={item === pageIndex ? BUTTON.primary : BUTTON.small}
                aria-label={t("settingsSecurity.paginationPage", { page: item + 1 })}
                aria-current={item === pageIndex ? "page" : undefined}
                onClick={() => onPageChange(item)}
              >
                {item + 1}
              </button>
            ),
          )}
          <button
            type="button"
            className={BUTTON.small}
            disabled={pageIndex >= pageCount - 1}
            onClick={() => onPageChange(pageIndex + 1)}
          >
            {t("settingsSecurity.paginationNext")}
          </button>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * A REVOKED session is not a connected device.
 *
 * `GET /api/account/security` deliberately returns the revoked sessions from
 * the last thirty days (`revoked_at > now() - interval '30 days'`, active ones
 * first): that is the account history, what OWASP calls « account
 * activity history ». The screen, for its part, never read `revokedAt`: it showed
 * revoked ones as connected, with a live « Révoquer » button. One
 * clicked, the API answered 204, the line did not move: the action worked,
 * the screen lied.
 *
 * The predicate is here, once, and serves the table as well as the tab badge.
 */
export function isActiveSession(session: AccountSessionDto): boolean {
  return session.revokedAt === null;
}

/**
 * The revocation reason, translated. `revokedReason` already crossed the API
 * (`sessions.revoked_reason`, migration 0019) and the DTO without anyone
 * reading it: fourteen identical « Révoquée » lines did not say whether the
 * session had closed itself or whether one had cut it off.
 *
 * An unknown reason (null column on rows from before the migration, or a
 * reason added later on the API side) returns `null`: one then shows the date
 * alone rather than a raw translation key.
 */
function revocationReason(session: AccountSessionDto, t: T): string | null {
  switch (session.revokedReason) {
    case "logout":
      return t("settingsSecurity.reasonLogout");
    case "user_revoked":
      return t("settingsSecurity.reasonUserRevoked");
    case "password_change":
      return t("settingsSecurity.reasonPasswordChange");
    case "refresh_rotation":
      return t("settingsSecurity.reasonRefreshRotation");
    default:
      return null;
  }
}

/**
 * The INSTANT that counts for a line: the last activity while the
 * session is alive, the revocation time as soon as it is cut off.
 *
 * The column showed `lastSeenAt` on every line. A session closed
 * just now therefore carried the time of its last request: sometimes several
 * minutes earlier, and did not rise in the sort: signing out then
 * signing back in changed nothing visible in the table, while the database
 * had just recorded both gestures.
 */
function activityAt(session: AccountSessionDto): string {
  return session.revokedAt ?? session.lastSeenAt;
}

/**
 * « Actif · vu 12:27 » or « Révoquée 12:14 · Déconnexion ».
 *
 * A bare date does not say which state the session is in: on a column of
 * eighteen lines of which seventeen start with « Révoquée », the living line
 * was the only one to announce nothing: the absence of a word does not read as a
 * state, it reads as a hole. Both states are named now, in the
 * same place, in the same form.
 */
/**
 * « 25 oct., 16:10 » this year, « 25 oct. 2025, 16:10 » before: the current
 * year teaches nothing and widened the Activité column to the point of
 * scrolling the table inside the settings modal.
 */
function formatActivityDate(value: string, locale: Locale, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.getFullYear() !== now.getFullYear()) return formatDate(value, locale);
  return formatDateI18n(locale, date, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function describeActivity(session: AccountSessionDto, t: T, locale: Locale): string {
  const date = formatActivityDate(activityAt(session), locale);
  if (isActiveSession(session)) return t("settingsSecurity.activeAtValue", { date });
  const reason = revocationReason(session, t);
  return reason
    ? t("settingsSecurity.revokedAtValueWithReason", { date, reason })
    : t("settingsSecurity.revokedAtValue", { date });
}

/**
 * A line's sort rank: this device, then the living sessions, then
 * the history. The current session is IN the table: « Appareils
 * connectés » that does not show the device one is on reads as a
 * broken screen, and that is exactly what one saw after a reconnect:
 * the new session was filtered, the old one joined the pile, and nothing
 * moved to the eye.
 */
function statusRank(session: AccountSessionDto): number {
  if (session.current) return 0;
  return isActiveSession(session) ? 1 : 2;
}

/**
 * A line's state badge: three states, a single place.
 *
 * `success` and not `info` for the current session: a pale blue outline in the
 * middle of seventeen gray pills does not stand apart from them. The green
 * says "it is alive", and that is the only fact this column must carry.
 */
function StatusBadge({ session, t }: { session: AccountSessionDto; t: T }) {
  if (session.current) return <ToneBadge tone="success">{t("settingsSecurity.currentDeviceBadge")}</ToneBadge>;
  if (isActiveSession(session)) return <ToneBadge tone="success">{t("settingsSecurity.statusActive")}</ToneBadge>;
  return <ToneBadge tone="neutral">{t("settingsSecurity.statusRevoked")}</ToneBadge>;
}

/** Revocable: alive AND not ours: the API answers 409 on the current one. */
function isRevocable(session: AccountSessionDto): boolean {
  return isActiveSession(session) && !session.current;
}

/** A device's readable name, never the raw `User-Agent` in full. */
export function describeDevice(session: AccountSessionDto | null, t: T): string {
  if (!session) return t("settingsSecurity.unknownValue");
  const { browser, platform } = describeUserAgent(session.userAgent);
  // A native session is the desktop app: its User-Agent is that of its
  // WebView or of its HTTP client, which would read as a browser, not as
  // the application's name.
  if (session.kind === "native") {
    return platform ? `${t("settingsSecurity.desktopApp")} · ${platform}` : t("settingsSecurity.desktopApp");
  }
  if (browser && platform) return `${browser} · ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  if (session.userAgent) return session.userAgent.slice(0, 60);
  return t("settingsSecurity.unknownDevice");
}

/**
 * A phone carries a phone icon, and a LIVING session carries a
 * green dot before it.
 *
 * The eye reads a line from left to right: putting the only state sign at
 * the end, in the « Statut » column, forces one to cross the whole line to
 * know whether the device is still connected. The dot says it at the first
 * character. It is decorative in the strict sense: the state stays stated in full
 * by the Activité column and by the pill, so nothing is lost
 * for a screen reader.
 */
function DeviceIcon({ session }: { session: AccountSessionDto }) {
  const { platform } = describeUserAgent(session.userAgent);
  const handheld = platform ? /iphone|ipad|android/i.test(platform) : false;
  const Icon = handheld ? IconDeviceMobile : IconDeviceLaptop;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-2">
      <span
        className={cn(
          "size-1.5 rounded-full",
          isActiveSession(session) ? "bg-pos-700 ring-2 ring-pos-700/25" : "bg-transparent",
        )}
      />
      <Icon className="size-4 shrink-0 text-muted-foreground" />
    </span>
  );
}

/**
 * A line's revocation button.
 *
 * `variant="ghost"` and not `danger`: six solid red buttons in a
 * table of six lines shout louder than the devices they serve.
 * The destructive intent passes through the TEXT COLOR, taken from
 * `--destructive-text`: `#c10007` in light, `#ff6467` in dark. That is the
 * point the dark theme missed: the old button had only a neutral
 * border and an inherited text, unreadable on a dark background and mute about what
 * the action was going to do.
 */
function RevokeButton({
  pending,
  onRevoke,
  t,
}: {
  pending: boolean;
  onRevoke: () => void;
  t: T;
}) {
  return (
    <button
      type="button"
      className={BUTTON.danger}
      disabled={pending}
      onClick={onRevoke}
    >
      {pending ? t("settingsSecurity.revoking") : t("settingsSecurity.revokeButton")}
    </button>
  );
}

/**
 * The account's devices, as a table: THIS device included.
 *
 * The columns are those OWASP asks to make visible to
 * the user (device, IP address, activity) plus the state, which distinguishes
 * the current session, a living session, and a session already cut off. The
 * default sort puts this device first, then the living ones, then the history,
 * each group from the most recent instant to the oldest.
 */
export function DevicesTable({
  sessions,
  revokingId,
  onRevoke,
  t,
  locale,
}: {
  sessions: AccountSessionDto[];
  revokingId: string | null;
  onRevoke: (sessionId: string) => void;
  t: T;
  locale: Locale;
}) {
  // This device, then the active ones, then the history, and within each group
  // the most recent instant first. The user's sort bears only on
  // the second key: a cut-off session must not be able to rise above
  // a living session.
  const [sorting, setSorting] = useState<SortingState>([
    { id: "status", desc: false },
    { id: "lastSeenAt", desc: true },
  ]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });
  const safePagination = {
    pageIndex: Math.min(
      pagination.pageIndex,
      Math.max(0, Math.ceil(sessions.length / PAGE_SIZE) - 1),
    ),
    pageSize: PAGE_SIZE,
  };

  const columns = useMemo<ColumnDef<AccountSessionDto>[]>(
    () => [
      {
        id: "device",
        accessorFn: (session) => describeDevice(session, t),
        header: t("settingsSecurity.deviceLabel"),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <DeviceIcon session={row.original} />
            <span
              className={cn(
                "font-medium",
                row.original.current && "font-semibold",
                !isActiveSession(row.original) && "text-muted-foreground",
              )}
            >
              {describeDevice(row.original, t)}
            </span>
          </div>
        ),
      },
      {
        id: "ip",
        accessorFn: (session) => session.ip ?? "",
        header: t("settingsSecurity.ipLabel"),
        cell: ({ row }) => (
          <span className={cn("text-muted-foreground", row.original.ip && "font-mono text-xs")}>
            {row.original.ip ?? t("settingsSecurity.unknownValue")}
          </span>
        ),
      },
      {
        id: "lastSeenAt",
        accessorFn: (session) => new Date(activityAt(session)).getTime(),
        // `toggleSorting` would replace the WHOLE sort state, status included, and
        // would let revoked ones interleave among the active ones. One therefore drives
        // only the second key; the first is pinned.
        header: () => (
          <button
            type="button"
            className="-ml-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              setSorting((previous) => [
                { id: "status", desc: false },
                { id: "lastSeenAt", desc: !(previous[1]?.desc ?? true) },
              ])
            }
          >
            {t("settingsSecurity.colLastActivity")}
            <IconArrowsSort className="size-3.5" />
          </button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {describeActivity(row.original, t, locale)}
          </span>
        ),
      },
      {
        id: "status",
        // 0, 1, 2 in ascending order: this device, the active ones, the history.
        accessorFn: (session) => statusRank(session),
        header: t("settingsSecurity.colStatus"),
        cell: ({ row }) => <StatusBadge session={row.original} t={t} />,
      },
      {
        id: "actions",
        // The header is empty to the eye, not to the screen reader: an
        // actions column with no name leaves « colonne 5 » as the only landmark.
        header: () => <span className="sr-only">{t("settingsSecurity.colActions")}</span>,
        cell: ({ row }) =>
          isRevocable(row.original) ? (
            <div className="flex justify-end">
              <RevokeButton
                pending={revokingId === row.original.id}
                onRevoke={() => onRevoke(row.original.id)}
                t={t}
              />
            </div>
          ) : null,
      },
    ],
    [t, locale, revokingId, onRevoke],
  );

  const table = useReactTable({
    // `sessions` MUST keep its reference between two renders: TanStack Table
    // sees a new array as new data, resets the page index
    // in a microtask, which re-renders, which builds an array again: the loop
    // that had frozen /settings/models on an empty roster. The caller
    // memoizes it (`useMemo` on `data.sessions`).
    data: sessions,
    columns,
    state: { sorting, pagination: safePagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const pageIndex = Math.min(pagination.pageIndex, Math.max(0, pageCount - 1));
  const from = filteredCount === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const to = Math.min(filteredCount, (pageIndex + 1) * PAGE_SIZE);

  return (
    // Flat in the « Appareils connectés » card: the card is the frame.
    <div className="min-w-0">
      <Table>
        <TableHeader className="bg-muted">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} colSpan={header.colSpan} className="px-3">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              // A revoked line is history: it is read, it is no longer
              // acted on.
              data-revoked={isActiveSession(row.original) ? undefined : ""}
              data-current={row.original.current ? "" : undefined}
              // No colored background on the current line: the green dot, the
              // emphasized name, « Actif · vu … » and the pill already say it
              // three times. An extra green band is noise, not signal.
              className={cn(!isActiveSession(row.original) && "bg-surface-sunken/40")}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="px-3 py-2">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DevicesPagination
        pageIndex={pageIndex}
        pageCount={Math.max(1, pageCount)}
        from={from}
        to={to}
        total={filteredCount}
        onPageChange={(next) => setPagination((previous) => ({ ...previous, pageIndex: next }))}
        t={t}
      />
    </div>
  );
}

/**
 * The same list under a finger: a five-column table on a phone reads
 * sideways or not at all. Same facts, same status, stacked.
 */
export function DevicesList({
  sessions,
  revokingId,
  onRevoke,
  t,
  locale,
}: {
  sessions: AccountSessionDto[];
  revokingId: string | null;
  onRevoke: (sessionId: string) => void;
  t: T;
  locale: Locale;
}): ReactNode {
  // The desktop table sorts by column; here the order is fixed, and it is the
  // same: this device, the active ones, the history: recent first.
  const [pageIndex, setPageIndex] = useState(0);
  const ordered = [...sessions].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      new Date(activityAt(b)).getTime() - new Date(activityAt(a)).getTime(),
  );
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const paged = ordered.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE);
  const from = ordered.length === 0 ? 0 : safePageIndex * PAGE_SIZE + 1;
  const to = Math.min(ordered.length, (safePageIndex + 1) * PAGE_SIZE);
  /*
    The device line, in iOS geometry: icon, name + state on one line,
    IP and activity on the second, and the removal at the END of the line, in red.

    It stacked a badge under the name when the two did not fit, and
    « Révoquer » ended up halfway up a three-line block: three
    different line heights in the same list. Here the state badge
    drops onto the meta line: there it is one fact among the others, and the
    line keeps one height.
  */
  return (
    <div>
    <ul className="openedbot-status-list -mx-4 list-none">
      {paged.map((session) => {
        const active = isActiveSession(session);
        return (
          <li
            key={session.id}
            data-current={session.current ? "" : undefined}
            className="flex min-h-16 items-center gap-3 px-4 py-2.5"
          >
            <DeviceIcon session={session} />
            <div className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-[17px] leading-[22px]",
                  session.current
                    ? "font-semibold text-[var(--openedbot-grouped-label)]"
                    : active
                      ? "text-[var(--openedbot-grouped-label)]"
                      : "text-[var(--openedbot-grouped-caption)]",
                )}
              >
                {describeDevice(session, t)}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                <StatusBadge session={session} t={t} />
                <span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-[var(--openedbot-grouped-caption)]">
                  <span className={session.ip ? "font-mono" : undefined}>
                    {session.ip ?? t("settingsSecurity.unknownValue")}
                  </span>
                  {" · "}
                  {describeActivity(session, t, locale)}
                </span>
              </span>
            </div>
            {isRevocable(session) ? (
              <RevokeButton
                pending={revokingId === session.id}
                onRevoke={() => onRevoke(session.id)}
                t={t}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
    <DevicesPagination
      pageIndex={safePageIndex}
      pageCount={pageCount}
      from={from}
      to={to}
      total={ordered.length}
      onPageChange={setPageIndex}
      t={t}
    />
    </div>
  );
}
