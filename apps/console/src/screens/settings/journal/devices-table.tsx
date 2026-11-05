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

/** Page DataTable classique : assez court pour lire une session, assez long pour l'historique. */
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
 * Une session RÉVOQUÉE n'est pas un appareil connecté.
 *
 * `GET /api/account/security` renvoie délibérément les sessions révoquées des
 * trente derniers jours (`revoked_at > now() - interval '30 days'`, actives en
 * tête) : c'est l'historique du compte, ce que l'OWASP appelle « account
 * activity history ». L'écran, lui, ne lisait jamais `revokedAt` : il montrait
 * les révoquées comme connectées, avec un bouton « Révoquer » vivant. On
 * cliquait, l'API répondait 204, la ligne ne bougeait pas : l'action marchait,
 * l'écran mentait.
 *
 * Le prédicat est ici, une fois, et sert au tableau comme au badge d'onglet.
 */
export function isActiveSession(session: AccountSessionDto): boolean {
  return session.revokedAt === null;
}

/**
 * Le motif de révocation, traduit. `revokedReason` traversait déjà l'API
 * (`sessions.revoked_reason`, migration 0019) et le DTO sans que personne ne
 * le lise : quatorze lignes « Révoquée » identiques ne disaient pas si la
 * session s'était fermée d'elle-même ou si on l'avait coupée.
 *
 * Un motif inconnu (colonne nulle sur les lignes d'avant la migration, ou un
 * motif ajouté plus tard côté API) rend `null` : on affiche alors la date
 * seule plutôt qu'une clé de traduction brute.
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
 * L'INSTANT qui compte pour une ligne : la dernière activité tant que la
 * session vit, l'heure de révocation dès qu'elle est coupée.
 *
 * La colonne montrait `lastSeenAt` sur toutes les lignes. Une session fermée
 * à l'instant portait donc l'heure de sa dernière requête : parfois plusieurs
 * minutes plus tôt, et ne remontait pas dans le tri : se déconnecter puis se
 * reconnecter ne changeait rien de visible dans le tableau, alors que la base
 * venait d'enregistrer les deux gestes.
 */
function activityAt(session: AccountSessionDto): string {
  return session.revokedAt ?? session.lastSeenAt;
}

/**
 * « Actif · vu 12:27 » ou « Révoquée 12:14 · Déconnexion ».
 *
 * Une date nue ne dit pas dans quel état est la session : sur une colonne de
 * dix-huit lignes dont dix-sept commencent par « Révoquée », la ligne vivante
 * était la seule à ne rien annoncer : l'absence de mot ne se lit pas comme un
 * état, elle se lit comme un trou. Les deux états se nomment maintenant, à la
 * même place, dans la même forme.
 */
/**
 * « 25 oct., 16:10 » cette année, « 25 oct. 2025, 16:10 » avant : l'année en
 * cours n'apprend rien et élargissait la colonne Activité au point de faire
 * défiler le tableau dans la modale des réglages.
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
 * Le rang de tri d'une ligne : cet appareil, puis les sessions vivantes, puis
 * l'historique. La session courante est DANS le tableau : « Appareils
 * connectés » qui n'affiche pas l'appareil sur lequel on est se lit comme un
 * écran cassé, et c'est exactement ce qu'on voyait après une reconnexion :
 * la nouvelle session était filtrée, l'ancienne rejoignait le tas, et rien ne
 * bougeait à l'œil.
 */
function statusRank(session: AccountSessionDto): number {
  if (session.current) return 0;
  return isActiveSession(session) ? 1 : 2;
}

/**
 * Le badge d'état d'une ligne : trois états, un seul endroit.
 *
 * `success` et non `info` pour la session courante : un contour bleu pâle au
 * milieu de dix-sept pastilles grises ne se distingue pas d'elles. Le vert
 * dit « ça vit », et c'est le seul fait que cette colonne doive porter.
 */
function StatusBadge({ session, t }: { session: AccountSessionDto; t: T }) {
  if (session.current) return <ToneBadge tone="success">{t("settingsSecurity.currentDeviceBadge")}</ToneBadge>;
  if (isActiveSession(session)) return <ToneBadge tone="success">{t("settingsSecurity.statusActive")}</ToneBadge>;
  return <ToneBadge tone="neutral">{t("settingsSecurity.statusRevoked")}</ToneBadge>;
}

/** Révocable : vivante ET pas la nôtre : l'API répond 409 sur la courante. */
function isRevocable(session: AccountSessionDto): boolean {
  return isActiveSession(session) && !session.current;
}

/** Le nom lisible d'un appareil, jamais l'`User-Agent` brut en entier. */
export function describeDevice(session: AccountSessionDto | null, t: T): string {
  if (!session) return t("settingsSecurity.unknownValue");
  const { browser, platform } = describeUserAgent(session.userAgent);
  // Une session native est la coque openedbot-desktop : son User-Agent est celui
  // d'Electron, qui se lirait « Chrome », pas le nom de l'application.
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
 * Un téléphone porte une icône de téléphone, et une session VIVANTE porte un
 * point vert avant elle.
 *
 * L'œil lit une ligne de gauche à droite : mettre le seul signe d'état au
 * bout, dans la colonne « Statut », oblige à traverser toute la ligne pour
 * savoir si l'appareil est encore connecté. Le point le dit au premier
 * caractère. Il est décoratif au sens strict : l'état reste énoncé en toutes
 * lettres par la colonne Activité et par la pastille, donc rien n'est perdu
 * pour un lecteur d'écran.
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
 * Le bouton de révocation d'une ligne.
 *
 * `variant="ghost"` et non `danger` : six boutons rouges pleins dans un
 * tableau de six lignes crient plus fort que les appareils qu'ils servent.
 * L'intention destructrice passe par la COULEUR DU TEXTE, prise sur
 * `--destructive-text` : `#c10007` en clair, `#ff6467` en sombre. C'est le
 * point que le thème sombre ratait : l'ancien bouton n'avait qu'une bordure
 * neutre et un texte hérité, illisible sur fond sombre et muet sur ce que
 * l'action allait faire.
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
 * Les appareils du compte, en tableau : CET appareil compris.
 *
 * Les colonnes sont celles que l'OWASP demande de rendre visibles à
 * l'utilisateur (appareil, adresse IP, activité) plus l'état, qui distingue
 * la session courante, une session vivante et une session déjà coupée. Le tri
 * par défaut met cet appareil en tête, puis les vivantes, puis l'historique,
 * chaque groupe de l'instant le plus récent au plus ancien.
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
  // Cet appareil, puis les actives, puis l'historique, et dans chaque groupe
  // l'instant le plus récent d'abord. Le tri de l'utilisateur ne porte que sur
  // la seconde clé : une session coupée ne doit pas pouvoir remonter au-dessus
  // d'une session vivante.
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
        // `toggleSorting` remplacerait TOUT l'état de tri, statut compris, et
        // laisserait les révoquées s'intercaler entre les actives. On ne pilote
        // donc que la seconde clé, la première est épinglée.
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
        // 0, 1, 2 en ordre croissant : cet appareil, les actives, l'historique.
        accessorFn: (session) => statusRank(session),
        header: t("settingsSecurity.colStatus"),
        cell: ({ row }) => <StatusBadge session={row.original} t={t} />,
      },
      {
        id: "actions",
        // L'en-tête est vide à l'œil, pas au lecteur d'écran : une colonne
        // d'actions sans nom laisse « colonne 5 » comme seul repère.
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
    // `sessions` DOIT garder sa référence entre deux rendus : TanStack Table
    // voit un nouveau tableau comme de nouvelles données, remet l'index de page
    // dans une microtâche, ce qui re-rend, ce qui refait un tableau : la boucle
    // qui avait figé /settings/models sur un roster vide. L'appelant le
    // mémorise (`useMemo` sur `data.sessions`).
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
    <div className="overflow-hidden rounded-lg border border-border">
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
              // Une ligne révoquée est de l'histoire : elle se lit, elle ne
              // s'actionne plus.
              data-revoked={isActiveSession(row.original) ? undefined : ""}
              data-current={row.original.current ? "" : undefined}
              // Pas de fond coloré sur la ligne courante : le point vert, le
              // nom appuyé, « Actif · vu … » et la pastille la disent déjà
              // trois fois. Une bande verte en plus est du bruit, pas du signal.
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
 * La même liste au doigt : un tableau à cinq colonnes sur un téléphone se lit
 * de travers ou pas du tout. Mêmes faits, même statut, empilés.
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
  // Le tableau desktop trie par colonne ; ici l'ordre est figé, et c'est le
  // même : cet appareil, les actives, l'historique : récent d'abord.
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
    La ligne d'appareil, en géométrie iOS : icône, nom + état sur une ligne,
    IP et activité sur la seconde, et le retrait en BOUT de ligne, en rouge.

    Elle empilait un badge sous le nom quand les deux ne tenaient pas, et
    « Révoquer » se retrouvait à mi-hauteur d'un pavé de trois lignes : trois
    hauteurs de ligne différentes dans une même liste. Ici le badge d'état
    descend sur la ligne de méta : il y est un fait parmi les autres, et la
    ligne garde une hauteur.
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
