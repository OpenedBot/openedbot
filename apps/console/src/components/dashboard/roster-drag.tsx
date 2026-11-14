import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";
import { GroupFaceStack } from "../group-face-stack";

/**
 * The roster's drag and drop, modelled on the reference app's (dnd-kit,
 * `PointerSensor` at 6 px, `DragOverlay`) but on the raw Pointer Events:
 * a native `<a>` in HTML5 drag carries its URL, not a card, and the native
 * ghost is not stylable.
 *
 * - A row (bot or group) lands on the pins grid, AT A
 *   SLOT: the grid opens live where the tile would fall. A
 *   pinned tile reorders there the same way.
 * - A row files into a section (anywhere, or at a precise rank:
 *   an insertion stroke); a pinned one that falls there is unpinned.
 * - A section header is dragged to reorder the sections; « Non
 *   assigné » stays at the bottom.
 *
 * The ghost (64 px face + name) is CENTRED on the cursor, the original
 * row fades, the list scrolls on its own near its edges, and on drop
 * the ghost flies to its place (or returns where it came from if one cancels).
 *
 * Mouse only (`pointerType === "mouse"`). With a finger, a long press is
 * the context menu (Radix opens at 700 ms) and the roster scrolls under the
 * finger; the finger goes through « Déplacer vers… », the iOS path.
 *
 * Targets declare themselves with `data-drop-section="<sectionId>"`, pinned
 * tiles with `data-pin-slot`, editable section blocks with
 * `data-section-block`, the scrolling container with `data-roster-scroll`.
 */
/** The pins grid (or the « Épingler » zone when it is empty). */
export const PINNED_DROP_ID = "__pinned__";
/** Below that, a `pointerdown` followed by a `pointerup` stays a click (dnd-kit `distance: 6`). */
const DRAG_SLOP = 6;
/** A row's ghost: the reference app's compact tile (`sand-pin-drag-ghost`, ~83 × 94). */
const GHOST_WIDTH = 84;
const GHOST_HEIGHT = 96;
/** Near an edge of the list, it scrolls, the faster the closer one gets. */
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_MAX_STEP = 14;
/** The ghost's flight to its place. */
const LANDING_MS = 220;
const LANDING_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export type RosterDragRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

/** Where the row would insert: before the target's row of index `index` (`index === rows.length`: at the end). */
export type RosterDropSlot = { sectionId: string; index: number };

/** A row's stable key: `bot:<id>` or `group:<id>`, the one of `data-pin-slot`. */
export function rosterRowKey(row: RosterDragRow): string {
  return row.kind === "bot" ? `bot:${row.bot.id}` : `group:${row.group.id}`;
}

export function isPinnedRow(row: RosterDragRow): boolean {
  return row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
}

/** Where the ghost lands at the end: aimed centre, scale, and whether it fades on the way. */
type Landing = { x: number; y: number; scale: number; fade: boolean };

export type RosterRowDrag = {
  row: RosterDragRow;
  key: string;
  x: number;
  y: number;
  /** The target under the pointer, `null` outside any target. */
  over: string | null;
  /** The insertion slot (grid or section); `null` = at the end of the section. */
  slot: RosterDropSlot | null;
  /** Set on release: the ghost flies, nothing is hovered any more. */
  landing: Landing | null;
};

export type RosterSectionDrag = {
  sectionId: string;
  label: string;
  x: number;
  y: number;
  /** The section's rank among the editable ones, at the start. */
  from: number;
  /** The drop stroke: before the editable section of index `index` (`=== count`: after the last). `null` outside the list. */
  index: number | null;
};

type DragSnapshot = { dragging: RosterRowDrag | null; sectionDrag: RosterSectionDrag | null };

/** The attributes a row sets to be a slot: `data-roster-row`, `data-roster-section`, `data-roster-index`. */
export function rosterRowAttributes(sectionId: string, index: number) {
  return { "data-roster-row": "", "data-roster-section": sectionId, "data-roster-index": String(index) } as const;
}

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * The slot aimed at in the pins grid, the reference app's `t3e`: the
 * tiles (without the one being carried), measured at the start of the drag, are
 * grouped by row; the row is chosen at the middle of the space between two
 * rows, then one counts, in that row, the tiles whose centre is
 * before the pointer (after, in RTL). The rank returned indexes the grid WITHOUT the
 * carried tile.
 */
export function pinSlotIndex(rects: ReadonlyArray<Rect>, x: number, y: number, rtl = false): number {
  if (rects.length === 0) return 0;
  const rows: Rect[][] = [];
  for (const rect of rects) {
    const current = rows.at(-1);
    const first = current?.[0];
    // Same row: the top of the tile falls in the upper half of the first.
    if (current && first && rect.top < first.top + (first.bottom - first.top) / 2) current.push(rect);
    else rows.push([rect]);
  }
  let rowIndex = rows.length - 1;
  for (let index = 0; index < rows.length - 1; index += 1) {
    const bottom = Math.max(...rows[index]!.map((rect) => rect.bottom));
    const nextTop = Math.min(...rows[index + 1]!.map((rect) => rect.top));
    if (y < (bottom + nextTop) / 2) {
      rowIndex = index;
      break;
    }
  }
  const before = rows.slice(0, rowIndex).reduce((sum, row) => sum + row.length, 0);
  const inRow = rows[rowIndex]!.filter((rect) => {
    const center = (rect.left + rect.right) / 2;
    return rtl ? center > x : center < x;
  }).length;
  return before + inRow;
}

/** A section's drop stroke: the number of editable sections whose middle is above the pointer. */
export function sectionSlotIndex(rects: ReadonlyArray<Rect>, y: number): number {
  return rects.filter((rect) => (rect.top + rect.bottom) / 2 < y).length;
}

type DragStore = {
  get: () => DragSnapshot;
  set: (next: DragSnapshot) => void;
  subscribe: (listener: () => void) => () => void;
};

function createDragStore(): DragStore {
  let snapshot: DragSnapshot = { dragging: null, sectionDrag: null };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set: (next) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type RowPointerDown = (row: RosterDragRow) => (event: ReactPointerEvent<HTMLElement>) => void;
type SectionPointerDown = (section: { id: string; label: string; from: number }) => (event: ReactPointerEvent<HTMLElement>) => void;

type RosterDragContextValue = {
  store: DragStore;
  /** A row's `onPointerDown`; `null` when drag is disabled. */
  pointerDownFor: RowPointerDown | null;
  /** An editable section header's `onPointerDown`; `null` when drag is disabled. */
  sectionPointerDownFor: SectionPointerDown | null;
};

const IDLE_STORE = createDragStore();
const RosterDragContext = createContext<RosterDragContextValue>({ store: IDLE_STORE, pointerDownFor: null, sectionPointerDownFor: null });

/** The whole drag state: for the targets (grid, sections, strokes), which repaint on every move. */
export function useRosterDrag(): DragSnapshot & Omit<RosterDragContextValue, "store"> {
  const { store, pointerDownFor, sectionPointerDownFor } = useContext(RosterDragContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { ...snapshot, pointerDownFor, sectionPointerDownFor };
}

/**
 * For a row: `"lifted"` while it is carried (faded), `"landing"`
 * while the ghost flies to its new place (invisible), `null`
 * otherwise. Repaints the row only on a phase change, not on every pixel.
 */
export function useRosterDragPhase(key: string): "lifted" | "landing" | null {
  const { store } = useContext(RosterDragContext);
  const read = () => {
    const dragging = store.get().dragging;
    if (dragging?.key !== key) return null;
    return dragging.landing ? "landing" : "lifted";
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The drag handles, stable: they do not subscribe to the movement. */
export function useRosterDragHandles(): Omit<RosterDragContextValue, "store"> {
  const { pointerDownFor, sectionPointerDownFor } = useContext(RosterDragContext);
  return { pointerDownFor, sectionPointerDownFor };
}

/** The grid's measurement at the start of the drag, adjusted for the list's scroll. */
type PinMeasure = { rects: Rect[]; scroller: HTMLElement | null; scrollTop: number; rtl: boolean };

function measurePins(excludeKey: string, scroller: HTMLElement | null): PinMeasure {
  const rects = [...document.querySelectorAll<HTMLElement>("[data-pin-slot]")]
    .filter((element) => element.dataset.pinSlot !== excludeKey)
    .map((element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    });
  const rtl = scroller ? getComputedStyle(scroller).direction === "rtl" : false;
  return { rects, scroller, scrollTop: scroller?.scrollTop ?? 0, rtl };
}

function pinIndexAt(measure: PinMeasure, x: number, y: number): number {
  const shift = measure.scrollTop - (measure.scroller?.scrollTop ?? 0);
  const rects = shift === 0 ? measure.rects : measure.rects.map((rect) => ({ ...rect, top: rect.top + shift, bottom: rect.bottom + shift }));
  return pinSlotIndex(rects, x, y, measure.rtl);
}

function rowTargetAt(x: number, y: number, measure: PinMeasure): { over: string | null; slot: RosterDropSlot | null } {
  const element = document.elementFromPoint(x, y);
  const over = element?.closest<HTMLElement>("[data-drop-section]")?.dataset.dropSection ?? null;
  if (over === PINNED_DROP_ID) return { over, slot: { sectionId: PINNED_DROP_ID, index: pinIndexAt(measure, x, y) } };
  const rowElement = element?.closest<HTMLElement>("[data-roster-row]") ?? null;
  if (!over || !rowElement || rowElement.dataset.rosterSection !== over) return { over, slot: null };
  // Upper half: before this row; lower half: after.
  const bounds = rowElement.getBoundingClientRect();
  const index = Number(rowElement.dataset.rosterIndex ?? 0);
  return { over, slot: { sectionId: over, index: y < bounds.top + bounds.height / 2 ? index : index + 1 } };
}

function sectionTargetAt(x: number, y: number): number | null {
  const scroller = document.elementFromPoint(x, y)?.closest("[data-roster-scroll]");
  if (!scroller) return null;
  const rects = [...scroller.querySelectorAll<HTMLElement>("[data-section-block]")].map((element) => element.getBoundingClientRect());
  return sectionSlotIndex(rects, y);
}

/** The ghost's centre over an element: a tile is aimed at by its top, a row by its face. */
function landingOn(element: Element | null, kind: "tile" | "row" | "line"): Landing | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (kind === "tile") return { x: rect.left + rect.width / 2, y: rect.top - 2 + GHOST_HEIGHT / 2, scale: 1, fade: false };
  // A row's face: 36 px, 8 px from the edge; the ghost shrinks onto it and fades.
  if (kind === "row") return { x: rect.left + 26, y: rect.top + rect.height / 2, scale: 0.45, fade: true };
  return { x: rect.left + 26, y: rect.top, scale: 0.45, fade: true };
}

function landingFor(dragging: RosterRowDrag, target: { over: string | null; slot: RosterDropSlot | null }): Landing | null {
  if (target.over === PINNED_DROP_ID) return landingOn(document.querySelector("[data-pin-placeholder]"), "tile");
  if (!target.over) return null;
  const line = document.querySelector("[data-roster-insertion]");
  if (line) return landingOn(line, "line");
  const section = [...document.querySelectorAll<HTMLElement>("[data-drop-section]")].find((element) => element.dataset.dropSection === target.over);
  return landingOn(section ?? null, "row") ?? null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function RosterDragProvider({
  enabled,
  onDrop,
  onSectionDrop,
  children,
}: {
  enabled: boolean;
  /** A row's drop; returns the announcement to read to screen readers. */
  onDrop: (row: RosterDragRow, target: string, slot: RosterDropSlot | null) => string | undefined;
  /** The drop of an editable section before the editable one of index `index`. */
  onSectionDrop?: (sectionId: string, index: number) => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const store = useMemo(createDragStore, []);
  const [announcement, setAnnouncement] = useState("");
  const onDropRef = useRef(onDrop);
  const onSectionDropRef = useRef(onSectionDrop);
  const tRef = useRef(t);
  useEffect(() => {
    onDropRef.current = onDrop;
    onSectionDropRef.current = onSectionDrop;
    tRef.current = t;
  }, [onDrop, onSectionDrop, t]);

  /**
   * The skeleton shared by both drags: a 6 px threshold, scrolling near
   * the edges, Escape, loss of focus, the following click swallowed. `move` receives the
   * position (and is called again when the list scrolls under a still pointer),
   * `end` the end (`drop` false: cancelled).
   */
  const track = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      handlers: { start: () => void; move: (x: number, y: number) => void; end: (drop: boolean, x: number, y: number) => void },
    ) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = event.currentTarget.closest<HTMLElement>("[data-roster-scroll]");
      let started = false;
      let last = { x: startX, y: startY };
      let frame = 0;

      const autoscroll = () => {
        frame = 0;
        if (!scroller) return;
        const bounds = scroller.getBoundingClientRect();
        const fromTop = last.y - bounds.top;
        const fromBottom = bounds.bottom - last.y;
        const step = fromTop < AUTOSCROLL_EDGE
          ? -Math.ceil(AUTOSCROLL_MAX_STEP * (1 - Math.max(0, fromTop) / AUTOSCROLL_EDGE))
          : fromBottom < AUTOSCROLL_EDGE
            ? Math.ceil(AUTOSCROLL_MAX_STEP * (1 - Math.max(0, fromBottom) / AUTOSCROLL_EDGE))
            : 0;
        if (step === 0 || last.x < bounds.left || last.x > bounds.right) return;
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop === before) return;
        handlers.move(last.x, last.y);
        frame = requestAnimationFrame(autoscroll);
      };

      const onMove = (move: PointerEvent) => {
        last = { x: move.clientX, y: move.clientY };
        if (!started) {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_SLOP) return;
          started = true;
          document.body.classList.add("openedbot-roster-dragging");
          handlers.start();
        }
        handlers.move(move.clientX, move.clientY);
        if (!frame) frame = requestAnimationFrame(autoscroll);
      };
      // If a NATIVE drag starts under the mouse (selected text, an image without
      // `draggable={false}`), WebKit cuts the Pointer Events without sending
      // `pointercancel`: the ghost would stay frozen. We suppress it.
      const onNativeDrag = (drag: DragEvent) => drag.preventDefault();
      const finish = (drop: boolean, at: { x: number; y: number }) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, { capture: true });
        window.removeEventListener("blur", onCancel);
        window.removeEventListener("dragstart", onNativeDrag, { capture: true });
        if (frame) cancelAnimationFrame(frame);
        if (!started) return;
        document.body.classList.remove("openedbot-roster-dragging");
        // The `click` that follows the release would open the thread (or collapse the
        // section) one just dropped. It fires in the same task as the
        // `pointerup`; if it does not come, the guard disarms at once.
        const swallowClick = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
        handlers.end(drop, at.x, at.y);
      };
      const onUp = (up: PointerEvent) => finish(true, { x: up.clientX, y: up.clientY });
      const onCancel = () => finish(false, last);
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !started) return;
        // Escape cancels the drag, and nothing else: not the search, not the drawer.
        key.preventDefault();
        key.stopPropagation();
        finish(false, last);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, { capture: true });
      window.addEventListener("blur", onCancel);
      window.addEventListener("dragstart", onNativeDrag, { capture: true });
    },
    [],
  );

  const pointerDownFor = useCallback<RowPointerDown>(
    (row) => (event) => {
      const key = rosterRowKey(row);
      const name = row.kind === "bot" ? row.bot.name : row.group.name;
      const source = event.currentTarget;
      const scroller = source.closest<HTMLElement>("[data-roster-scroll]");
      let measure: PinMeasure = { rects: [], scroller, scrollTop: 0, rtl: false };
      track(event, {
        start: () => {
          measure = measurePins(key, scroller);
        },
        move: (x, y) => store.set({ sectionDrag: null, dragging: { row, key, x, y, landing: null, ...rowTargetAt(x, y, measure) } }),
        end: (drop, x, y) => {
          const current = store.get().dragging;
          const target = drop ? rowTargetAt(x, y, measure) : { over: null, slot: null };
          const placed = target.over !== null;
          // The aimed place is read BEFORE the drop: the open slot in
          // the grid disappears as soon as the roster is rewritten.
          const landing = placed && current
            ? landingFor(current, target)
            : landingOn(source.isConnected ? source : null, isPinnedRow(row) ? "tile" : "row");
          if (placed) setAnnouncement(onDropRef.current(row, target.over!, target.slot) ?? "");
          else setAnnouncement(tRef.current("appSidebar.dragAnnounceCanceled", { name }));
          if (!landing || prefersReducedMotion() || !current) {
            store.set({ dragging: null, sectionDrag: null });
            return;
          }
          store.set({ sectionDrag: null, dragging: { ...current, x, y, over: null, slot: null, landing } });
        },
      });
    },
    [store, track],
  );

  const sectionPointerDownFor = useCallback<SectionPointerDown>(
    (section) => (event) => {
      track(event, {
        start: () => undefined,
        move: (x, y) => store.set({
          dragging: null,
          sectionDrag: { sectionId: section.id, label: section.label, from: section.from, x, y, index: sectionTargetAt(x, y) },
        }),
        end: (drop, x, y) => {
          store.set({ dragging: null, sectionDrag: null });
          const index = drop ? sectionTargetAt(x, y) : null;
          if (index === null || index === section.from || index === section.from + 1) return;
          onSectionDropRef.current?.(section.id, index);
          setAnnouncement(tRef.current("appSidebar.dragAnnounceSection", { name: section.label }));
        },
      });
    },
    [store, track],
  );

  const value = useMemo<RosterDragContextValue>(
    () => ({
      store,
      pointerDownFor: enabled ? pointerDownFor : null,
      sectionPointerDownFor: enabled && onSectionDrop ? sectionPointerDownFor : null,
    }),
    [enabled, onSectionDrop, pointerDownFor, sectionPointerDownFor, store],
  );

  return (
    <RosterDragContext.Provider value={value}>
      {children}
      <DragLayer store={store} />
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
    </RosterDragContext.Provider>
  );
}

function DragLayer({ store }: { store: DragStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  const onLanded = useCallback(() => store.set({ dragging: null, sectionDrag: null }), [store]);
  if (snapshot.dragging) return <RowGhost state={snapshot.dragging} onLanded={onLanded} />;
  if (snapshot.sectionDrag) return <SectionGhost state={snapshot.sectionDrag} />;
  return null;
}

/**
 * A row's ghost, the reference app's `sand-pin-drag-ghost`: the face
 * (64 px), the name underneath, on a small card, centred on the cursor
 * (`snapCenterToCursor`). On drop, it flies to its place then disappears.
 */
function RowGhost({ state, onLanded }: { state: RosterRowDrag; onLanded: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { landing } = state;
  useLayoutEffect(() => {
    if (!landing) return;
    const element = ref.current;
    if (!element || typeof element.animate !== "function") {
      onLanded();
      return;
    }
    const animation = element.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        {
          transform: `translate(${landing.x - state.x}px, ${landing.y - state.y}px) scale(${landing.scale})`,
          opacity: landing.fade ? 0 : 1,
        },
      ],
      { duration: LANDING_MS, easing: LANDING_EASING, fill: "forwards" },
    );
    animation.onfinish = onLanded;
    // A background tab does not play the animation: the ghost must not stay.
    const fallback = window.setTimeout(onLanded, LANDING_MS + 150);
    return () => {
      window.clearTimeout(fallback);
      animation.onfinish = null;
    };
    // `state.x` / `state.y` are frozen during the landing.
  }, [landing]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = state.row.kind === "bot" ? state.row.bot.name : state.row.group.name;
  return createPortal(
    <div
      ref={ref}
      aria-hidden
      data-roster-ghost=""
      className="pointer-events-none fixed z-[130] flex flex-col items-center gap-1 rounded-2xl bg-popover px-1.5 pt-2 pb-1.5 text-popover-foreground shadow-lg ring-1 ring-border/60"
      style={{ left: state.x - GHOST_WIDTH / 2, top: state.y - GHOST_HEIGHT / 2, width: GHOST_WIDTH, height: GHOST_HEIGHT }}
    >
      {state.row.kind === "bot" ? (
        <BotFace name={state.row.bot.name} seed={state.row.bot.id} face={state.row.bot.face} className="size-16" />
      ) : (
        <GroupFaceStack members={state.row.group.members} size="size-8" className="size-16 justify-center" />
      )}
      <span className="max-w-full truncate text-[12px] leading-4 font-medium">{name}</span>
    </div>,
    document.body,
  );
}

/** A section's ghost, the reference app's `drag-preview`: its name, on a pill, beside the cursor. */
function SectionGhost({ state }: { state: RosterSectionDrag }) {
  return createPortal(
    <div
      aria-hidden
      data-roster-ghost=""
      className="pointer-events-none fixed z-[130] max-w-56 truncate rounded-lg bg-popover px-2.5 py-1.5 text-[13px] leading-[18px] font-medium text-popover-foreground shadow-lg ring-1 ring-border/60"
      style={{ left: state.x + 12, top: state.y - 14 }}
    >
      {state.label}
    </div>,
    document.body,
  );
}
