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
 * Le glisser-déposer du roster, calqué sur celui de Grok Bot (dnd-kit,
 * `PointerSensor` à 6 px, `DragOverlay`) mais sur les Pointer Events nus :
 * un `<a>` natif en drag HTML5 emporte son URL, pas une carte, et le fantôme
 * natif n'est pas stylable.
 *
 * - Une ligne (bot ou salon) se pose sur la grille des épinglés, À UN
 *   EMPLACEMENT : la grille s'ouvre en direct là où la tuile tomberait. Une
 *   tuile épinglée s'y réordonne de même.
 * - Une ligne se range dans une section (n'importe où, ou à un rang précis :
 *   trait d'insertion) ; une épinglée qui y tombe est désépinglée.
 * - Un en-tête de section se glisse pour réordonner les sections ; « Non
 *   assigné » reste en bas.
 *
 * Le fantôme (visage 64 px + nom) est CENTRÉ sur le curseur, la ligne
 * d'origine s'estompe, la liste défile seule près de ses bords, et au dépôt
 * le fantôme vole jusqu'à sa place (ou revient d'où il vient si on annule).
 *
 * Souris seulement (`pointerType === "mouse"`). Au doigt, un appui long est
 * le menu contextuel (Radix ouvre à 700 ms) et le roster défile sous le
 * doigt ; le doigt passe par « Déplacer vers… », la voie iOS.
 *
 * Les cibles se déclarent par `data-drop-section="<sectionId>"`, les tuiles
 * épinglées par `data-pin-slot`, les blocs de section éditables par
 * `data-section-block`, le conteneur qui défile par `data-roster-scroll`.
 */
/** La grille des épinglés (ou la zone « Épingler » quand elle est vide). */
export const PINNED_DROP_ID = "__pinned__";
/** En deçà, un `pointerdown` suivi d'un `pointerup` reste un clic (dnd-kit `distance: 6`). */
const DRAG_SLOP = 6;
/** Le fantôme d'une ligne : la tuile compacte de Grok (`sand-pin-drag-ghost`, ~83 × 94). */
const GHOST_WIDTH = 84;
const GHOST_HEIGHT = 96;
/** Près d'un bord de la liste, elle défile, d'autant plus vite qu'on s'en approche. */
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_MAX_STEP = 14;
/** Le vol du fantôme jusqu'à sa place. */
const LANDING_MS = 220;
const LANDING_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export type RosterDragRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

/** Où la ligne s'insérerait : avant la ligne d'index `index` de la cible (`index === rows.length` : en fin). */
export type RosterDropSlot = { sectionId: string; index: number };

/** La clé stable d'une ligne : `bot:<id>` ou `group:<id>`, celle de `data-pin-slot`. */
export function rosterRowKey(row: RosterDragRow): string {
  return row.kind === "bot" ? `bot:${row.bot.id}` : `group:${row.group.id}`;
}

export function isPinnedRow(row: RosterDragRow): boolean {
  return row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
}

/** Là où le fantôme se pose à la fin : centre visé, échelle, et s'il s'efface en route. */
type Landing = { x: number; y: number; scale: number; fade: boolean };

export type RosterRowDrag = {
  row: RosterDragRow;
  key: string;
  x: number;
  y: number;
  /** La cible sous le pointeur, `null` hors de toute cible. */
  over: string | null;
  /** L'emplacement d'insertion (grille ou section) ; `null` = en fin de section. */
  slot: RosterDropSlot | null;
  /** Posé au relâchement : le fantôme vole, plus rien n'est survolé. */
  landing: Landing | null;
};

export type RosterSectionDrag = {
  sectionId: string;
  label: string;
  x: number;
  y: number;
  /** Le rang de la section parmi les éditables, au départ. */
  from: number;
  /** Le trait de dépôt : avant la section éditable d'index `index` (`=== count` : après la dernière). `null` hors de la liste. */
  index: number | null;
};

type DragSnapshot = { dragging: RosterRowDrag | null; sectionDrag: RosterSectionDrag | null };

/** Les attributs qu'une ligne pose pour être un créneau : `data-roster-row`, `data-roster-section`, `data-roster-index`. */
export function rosterRowAttributes(sectionId: string, index: number) {
  return { "data-roster-row": "", "data-roster-section": sectionId, "data-roster-index": String(index) } as const;
}

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * L'emplacement visé dans la grille des épinglés, le `t3e` de Grok : les
 * tuiles (sans celle qu'on porte), mesurées au début du glisser, sont
 * groupées par rangée ; la rangée se choisit au milieu de l'espace entre deux
 * rangées, puis on compte, dans cette rangée, les tuiles dont le centre est
 * avant le pointeur (après, en RTL). Le rang rendu indexe la grille SANS la
 * tuile portée.
 */
export function pinSlotIndex(rects: ReadonlyArray<Rect>, x: number, y: number, rtl = false): number {
  if (rects.length === 0) return 0;
  const rows: Rect[][] = [];
  for (const rect of rects) {
    const current = rows.at(-1);
    const first = current?.[0];
    // Même rangée : le haut de la tuile tombe dans la moitié haute de la première.
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

/** Le trait de dépôt d'une section : le nombre de sections éditables dont le milieu est au-dessus du pointeur. */
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
  /** Le `onPointerDown` d'une ligne ; `null` quand le drag est désactivé. */
  pointerDownFor: RowPointerDown | null;
  /** Le `onPointerDown` d'un en-tête de section éditable ; `null` quand le drag est désactivé. */
  sectionPointerDownFor: SectionPointerDown | null;
};

const IDLE_STORE = createDragStore();
const RosterDragContext = createContext<RosterDragContextValue>({ store: IDLE_STORE, pointerDownFor: null, sectionPointerDownFor: null });

/** Tout l'état du glisser : pour les cibles (grille, sections, traits), qui se repeignent à chaque mouvement. */
export function useRosterDrag(): DragSnapshot & Omit<RosterDragContextValue, "store"> {
  const { store, pointerDownFor, sectionPointerDownFor } = useContext(RosterDragContext);
  const snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { ...snapshot, pointerDownFor, sectionPointerDownFor };
}

/**
 * Pour une ligne : `"lifted"` pendant qu'on la porte (estompée), `"landing"`
 * pendant que le fantôme vole vers sa nouvelle place (invisible), `null`
 * sinon. Ne repeint la ligne qu'au changement de phase, pas à chaque pixel.
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

/** Les poignées de glisser, stables : n'abonnent pas au mouvement. */
export function useRosterDragHandles(): Omit<RosterDragContextValue, "store"> {
  const { pointerDownFor, sectionPointerDownFor } = useContext(RosterDragContext);
  return { pointerDownFor, sectionPointerDownFor };
}

/** La mesure de la grille au départ du glisser, recalée sur le défilement de la liste. */
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
  // Moitié haute : avant cette ligne ; moitié basse : après.
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

/** Le centre du fantôme au-dessus d'un élément : une tuile se vise par le haut, une ligne par son visage. */
function landingOn(element: Element | null, kind: "tile" | "row" | "line"): Landing | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (kind === "tile") return { x: rect.left + rect.width / 2, y: rect.top - 2 + GHOST_HEIGHT / 2, scale: 1, fade: false };
  // Le visage d'une ligne : 36 px à 8 px du bord ; le fantôme s'y réduit et s'efface.
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
  /** Le dépôt d'une ligne ; rend l'annonce à lire aux lecteurs d'écran. */
  onDrop: (row: RosterDragRow, target: string, slot: RosterDropSlot | null) => string | undefined;
  /** Le dépôt d'une section éditable avant l'éditable d'index `index`. */
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
   * Le squelette commun aux deux glissers : seuil de 6 px, défilement près
   * des bords, Échap, perte de focus, clic suivant avalé. `move` reçoit la
   * position (et est rappelé quand la liste défile sous un pointeur immobile),
   * `end` la fin (`drop` faux : annulé).
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
          document.body.classList.add("ohb-roster-dragging");
          handlers.start();
        }
        handlers.move(move.clientX, move.clientY);
        if (!frame) frame = requestAnimationFrame(autoscroll);
      };
      // Si un drag NATIF démarre sous la souris (texte sélectionné, image sans
      // `draggable={false}`), WebKit coupe les Pointer Events sans envoyer
      // `pointercancel` : le fantôme resterait figé. On l'étouffe.
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
        document.body.classList.remove("ohb-roster-dragging");
        // Le `click` qui suit le relâchement ouvrirait le fil (ou replierait la
        // section) qu'on vient de déposer. Il part dans la même tâche que le
        // `pointerup` ; s'il ne vient pas, le garde se désarme aussitôt.
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
        // Échap annule le glisser, et rien d'autre : pas la recherche, pas le tiroir.
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
          // La place visée se lit AVANT le dépôt : l'emplacement ouvert dans
          // la grille disparaît dès que le roster est réécrit.
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
 * Le fantôme d'une ligne, la `sand-pin-drag-ghost` de Grok Bot : le visage
 * (64 px), le nom dessous, sur une petite carte, centrée sur le curseur
 * (`snapCenterToCursor`). Au dépôt, il vole jusqu'à sa place puis disparaît.
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
    // Un onglet en arrière-plan ne joue pas l'animation : le fantôme ne doit pas rester.
    const fallback = window.setTimeout(onLanded, LANDING_MS + 150);
    return () => {
      window.clearTimeout(fallback);
      animation.onfinish = null;
    };
    // `state.x` / `state.y` sont figés pendant l'atterrissage.
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

/** Le fantôme d'une section, le `drag-preview` de Grok : son nom, sur une pastille, à côté du curseur. */
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
