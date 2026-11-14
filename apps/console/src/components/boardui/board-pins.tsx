import { Fragment, memo, useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { BotContextMenu } from "../bot-context-menu";
import { BotFace } from "../bot-face";
import { GroupContextMenu } from "../group-context-menu";
import { GroupFaceStack } from "../group-face-stack";
import {
  PINNED_DROP_ID,
  isPinnedRow,
  rosterRowKey,
  useRosterDrag,
  useRosterDragHandles,
  useRosterDragPhase,
  type RosterDragRow,
} from "../dashboard/roster-drag";

type PinRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

const PIN_TILE =
  "flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/** A pin's rank: its `pinPosition`, then activity; a pin with no rank (menu, before 0159) comes after. */
export function comparePinned(a: PinRow, b: PinRow): number {
  const rank = (row: PinRow) => (row.kind === "bot" ? row.bot.pinPosition : row.group.pinPosition) ?? Number.POSITIVE_INFINITY;
  const activity = (row: PinRow) => (row.kind === "bot" ? row.bot.lastActivityAt : row.group.lastActivityAt);
  return rank(a) - rank(b) || activity(b).localeCompare(activity(a));
}

/**
 * What the grid shows during a drag: while hovered, the carried tile
 * (faded) inserts at the aimed slot and the others move aside, as
 * in the reference app; otherwise the real order.
 */
export function pinPreview<Row extends PinRow>(
  rows: ReadonlyArray<Row>,
  dragged: RosterDragRow | null,
  slotIndex: number | null,
): Array<{ row: Row | RosterDragRow; placeholder: boolean }> {
  const real = rows.map((row) => ({ row: row as Row | RosterDragRow, placeholder: false }));
  if (!dragged || slotIndex === null) return real;
  const key = rosterRowKey(dragged);
  const others = real.filter((item) => rosterRowKey(item.row) !== key);
  const at = Math.min(Math.max(slotIndex, 0), others.length);
  return [...others.slice(0, at), { row: dragged, placeholder: true }, ...others.slice(at)];
}

/**
 * Tiles that change place slide to the new one (FLIP) instead
 * of jumping. Layout positions (`offsetLeft`), not
 * `getBoundingClientRect`: a tile in mid-flight does not skew the measurement.
 */
function useFlip(root: React.RefObject<HTMLElement | null>) {
  const previous = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, { x: number; y: number }>();
    for (const element of container.querySelectorAll<HTMLElement>(":scope > [data-flip-key]")) {
      const key = element.dataset.flipKey!;
      const position = { x: element.offsetLeft, y: element.offsetTop };
      next.set(key, position);
      const before = previous.current.get(key);
      if (reduce || !before || typeof element.animate !== "function") continue;
      if (before.x === position.x && before.y === position.y) continue;
      element.animate(
        [{ transform: `translate(${before.x - position.x}px, ${before.y - position.y}px)` }, { transform: "none" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
    previous.current = next;
  });
}

/** The pins grid: the drag target when it is populated, with its live slot. */
export function PinRail<Row extends PinRow>({
  rows,
  renderTile,
}: {
  rows: ReadonlyArray<Row>;
  renderTile: (row: Row) => ReactNode;
}) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  const ref = useRef<HTMLUListElement>(null);
  const over = dragging?.over === PINNED_DROP_ID;
  const items = pinPreview(rows, dragging?.row ?? null, over ? dragging.slot?.index ?? null : null);
  useFlip(ref);
  return (
    <ul
      ref={ref}
      aria-label={t("appSidebar.pinnedGroup")}
      data-drop-section={PINNED_DROP_ID}
      className={cn(
        "relative flex shrink-0 flex-wrap justify-center gap-x-3 gap-y-3 rounded-xl px-1 pt-2 pb-3 transition-colors duration-150",
        over && "bg-background-tertiary-hover",
      )}
    >
      {items.map((item) => (
        <Fragment key={item.placeholder ? `placeholder:${rosterRowKey(item.row)}` : rosterRowKey(item.row)}>
          {item.placeholder ? <PinPlaceholder row={item.row} /> : renderTile(item.row as Row)}
        </Fragment>
      ))}
    </ul>
  );
}

/** The open slot: the carried tile, faded, where it will land. Neither a link nor a menu. */
function PinPlaceholder({ row }: { row: RosterDragRow }) {
  const name = row.kind === "bot" ? row.bot.name : row.group.name;
  return (
    <li aria-hidden data-flip-key={rosterRowKey(row)} data-pin-placeholder="" className="w-[7.25rem] opacity-40">
      <span className={PIN_TILE}>
        {row.kind === "bot" ? (
          <BotFace name={row.bot.name} seed={row.bot.id} face={row.bot.face} className="size-16" />
        ) : (
          <GroupFaceStack members={row.group.members} size="size-8" className="size-16 justify-center" />
        )}
        <span className="w-full truncate text-body-2-medium text-text-primary">{name}</span>
      </span>
    </li>
  );
}

/**
 * A status badge on the bottom-right corner of the face, like the reference app's
 * pins rail: the blue dot (unread) bites the edge of the shape.
 */
function PinStatus({ running, unread, awaiting }: { running?: boolean; unread?: boolean; awaiting?: boolean }) {
  const { t } = useT();
  if (!running && !unread && !awaiting) return null;
  return (
    <span className="absolute -right-0.5 -bottom-0.5 flex">
      {running ? (
        <span role="status" aria-label={t("appSidebar.running")} className="bui-breathing-dot size-2.5 rounded-full bg-accent-500 ring-2 ring-background-secondary-default" />
      ) : unread ? (
        <span role="status" aria-label={t("appSidebar.unread")} className="size-2.5 rounded-full bg-accent-500 ring-2 ring-background-secondary-default" />
      ) : null}
      {awaiting ? (
        <span role="status" aria-label={t("appSidebar.awaitingApproval")} className="size-2.5 rounded-full bg-warn-700 ring-2 ring-background-secondary-default" />
      ) : null}
    </span>
  );
}

/**
 * A pin: face large, name underneath, no longer a row in the list.
 * The context menu is the row's (unpin included). While carried,
 * the tile fades; while the ghost sits on it, it waits
 * invisible.
 */
export const PinnedTile = memo(function PinnedTile({
  row,
  active,
  onRename,
  onNavigate,
}: {
  row: PinRow;
  active: boolean;
  onRename: (botId: string) => void;
  onNavigate: () => void;
}) {
  const { pointerDownFor } = useRosterDragHandles();
  const key = rosterRowKey(row);
  const phase = useRosterDragPhase(key);
  const className = cn(
    PIN_TILE,
    active && "bg-background-tertiary-default",
    "hover:bg-background-tertiary-hover",
    phase === "lifted" && "opacity-40",
    phase === "landing" && "opacity-0",
  );
  const onPointerDown = pointerDownFor?.(row);
  if (row.kind === "bot") {
    const bot = row.bot;
    return (
      <li className="w-[7.25rem]" data-pin-slot={key} data-flip-key={key}>
        <BotContextMenu bot={bot} onRename={() => onRename(bot.id)}>
          <Link
            to="/bot/$botId"
            params={{ botId: bot.id }}
            draggable={false}
            title={bot.name}
            aria-current={active ? "page" : undefined}
            aria-haspopup="menu"
            onPointerDown={onPointerDown}
            onClick={onNavigate}
            className={className}
          >
            <span className="relative">
              <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-16" />
              <PinStatus running={bot.running} unread={bot.unread} awaiting={bot.awaitingApproval} />
            </span>
            <span className="w-full truncate text-body-2-medium text-text-primary">{bot.name}</span>
          </Link>
        </BotContextMenu>
      </li>
    );
  }
  const group = row.group;
  return (
    <li className="w-[7.25rem]" data-pin-slot={key} data-flip-key={key}>
      <GroupContextMenu group={group}>
        <Link
          to="/g/$groupId"
          params={{ groupId: group.id }}
          draggable={false}
          title={group.name}
          aria-current={active ? "page" : undefined}
          aria-haspopup="menu"
          onPointerDown={onPointerDown}
          onClick={onNavigate}
          className={className}
        >
          <span className="relative">
            <GroupFaceStack members={group.members} size="size-8" className="size-16 justify-center" />
            <PinStatus running={group.running} unread={group.unread} awaiting={group.awaitingApproval || group.needsYou} />
          </span>
          <span className="w-full truncate text-body-2-medium text-text-primary">{group.name}</span>
        </Link>
      </GroupContextMenu>
    </li>
  );
});

const DROP_ZONE =
  "flex h-16 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-border-button-white px-3 text-center text-body-2-medium text-text-tertiary transition-colors duration-150";
const DROP_ZONE_OVER = "border-text-secondary bg-background-tertiary-hover text-text-primary";

/**
 * The « Désépingler » zone, visible only during a pin's drag when
 * the flat list is empty: without it, the list (the only target, 0 px tall)
 * offered nowhere to drop the tile to put it back in the list.
 */
export function BoardUnpinDropZone({ sectionId }: { sectionId: string }) {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  if (!dragging || dragging.landing || !isPinnedRow(dragging.row)) return null;
  return (
    <div data-drop-section={sectionId} className={cn(DROP_ZONE, dragging.over === sectionId && DROP_ZONE_OVER)}>
      {t("appSidebar.dropToUnpin")}
    </div>
  );
}

/** The « Épingler » zone, visible only during a drag, when the grid is empty. */
export function BoardPinDropZone() {
  const { t } = useT();
  const { dragging } = useRosterDrag();
  if (!dragging || dragging.landing) return null;
  return (
    <div data-drop-section={PINNED_DROP_ID} className={cn(DROP_ZONE, dragging.over === PINNED_DROP_ID && DROP_ZONE_OVER)}>
      {t("appSidebar.dropToPin")}
    </div>
  );
}
