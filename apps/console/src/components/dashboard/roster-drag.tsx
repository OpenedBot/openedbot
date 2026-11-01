import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { BotFace } from "../bot-face";
import { GroupFaceStack } from "../group-face-stack";

/**
 * Le glisser-déposer du roster : une ligne prise à la souris, pour
 * épingler (zone sous la recherche), réordonner DANS une section, ou
 * ranger dans n'importe quelle autre (y compris « Non assigné »). L'idiome
 * de Grok Bot (`sidebar.tsx`), réécrit sur les Pointer Events plutôt que
 * sur l'API HTML5 : un `<a>` natif en drag emporte son URL, pas une carte,
 * et le rendu du fantôme n'est pas stylable.
 *
 * Souris seulement (`pointerType === "mouse"`). Au doigt, un appui long est
 * déjà pris : c'est le menu contextuel (Radix ouvre à 700 ms), et le
 * roster défile sous le doigt : un drag tactile devrait voler le scroll et
 * concurrencer le menu. Le doigt passe par « Déplacer vers… » dans ce menu,
 * qui ouvre une feuille : la voie iOS.
 *
 * Les cibles se déclarent par `data-drop-section="<sectionId>"` ; le
 * fantôme suit le pointeur en `pointer-events: none`, donc
 * `elementFromPoint` voit toujours ce qu'il y a dessous.
 */
/** La zone « Épingler » sous la recherche, et le groupe « Épinglés » lui-même. */
export const PINNED_DROP_ID = "__pinned__";
/** En deçà, un `pointerdown` suivi d'un `pointerup` reste un clic. */
const DRAG_SLOP = 6;
/** La carte du fantôme : `w-20`, et à peu près aussi haute (visage 40 px + nom). */
const GHOST_SIZE = 80;
/** Le fantôme se pose en bas à droite de la pointe du curseur, comme le fantôme natif. */
const GHOST_OFFSET = 16;
/** Marge minimale entre le fantôme et le bord de la fenêtre. */
const GHOST_MARGIN = 8;

export type RosterDragRow = { kind: "bot"; bot: BotDto } | { kind: "group"; group: GroupDto };

/** Où la ligne s'insérerait : avant la ligne d'index `index` de la section (`index === rows.length` : en fin). */
export type RosterDropSlot = { sectionId: string; index: number };

type DragState = {
  row: RosterDragRow;
  x: number;
  y: number;
  /** La cible sous le pointeur, `null` hors de toute section. */
  over: string | null;
  /** Le créneau d'insertion quand le pointeur survole une ligne ; `null` = en fin de section. */
  slot: RosterDropSlot | null;
};

/** Les attributs qu'une ligne pose pour être un créneau : `data-roster-row`, `data-roster-section`, `data-roster-index`. */
export function rosterRowAttributes(sectionId: string, index: number) {
  return { "data-roster-row": "", "data-roster-section": sectionId, "data-roster-index": String(index) } as const;
}

type RosterDragContextValue = {
  dragging: DragState | null;
  /** Le `onPointerDown` d'une ligne ; `null` quand le drag est désactivé. */
  pointerDownFor: ((row: RosterDragRow) => (event: ReactPointerEvent<HTMLElement>) => void) | null;
};

const RosterDragContext = createContext<RosterDragContextValue>({ dragging: null, pointerDownFor: null });

export function useRosterDrag(): RosterDragContextValue {
  return useContext(RosterDragContext);
}

function dropTargetAt(x: number, y: number, row: RosterDragRow): { over: string | null; slot: RosterDropSlot | null } {
  const element = document.elementFromPoint(x, y);
  const hovered = element?.closest<HTMLElement>("[data-drop-section]")?.dataset.dropSection ?? null;
  // Toute section est une cible, « Non assigné » comprise. Une épinglée ne
  // vise plus le groupe des épinglés : le dépôt la range et la désépingle.
  // Une ligne de section vise aussi la zone « Épingler ».
  const pinned = row.kind === "bot" ? row.bot.pinned : row.group.pinned === true;
  const over = pinned && hovered === PINNED_DROP_ID ? null : hovered;
  const rowElement = element?.closest<HTMLElement>("[data-roster-row]") ?? null;
  if (!rowElement || rowElement.dataset.rosterSection !== over) return { over, slot: null };
  // Moitié haute : avant cette ligne ; moitié basse : après, le midpoint de
  // Grok (`onDrop` des épinglés).
  const bounds = rowElement.getBoundingClientRect();
  const index = Number(rowElement.dataset.rosterIndex ?? 0);
  return { over, slot: { sectionId: over as string, index: y < bounds.top + bounds.height / 2 ? index : index + 1 } };
}

export function RosterDragProvider({
  enabled,
  onDrop,
  children,
}: {
  enabled: boolean;
  onDrop: (row: RosterDragRow, sectionId: string, slot: RosterDropSlot | null) => void;
  children: ReactNode;
}) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  const pointerDownFor = useCallback(
    (row: RosterDragRow) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let started = false;

      const onMove = (move: PointerEvent) => {
        if (!started) {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_SLOP) return;
          started = true;
          document.body.classList.add("ohb-roster-dragging");
        }
        setDragging({ row, x: move.clientX, y: move.clientY, ...dropTargetAt(move.clientX, move.clientY, row) });
      };
      // Si un drag NATIF démarre sous la souris (texte sélectionné dans la
      // ligne, image sans `draggable={false}`), WebKit (le webview Tauri, le
      // Safari d'un iPad à la souris) coupe les Pointer Events sans envoyer
      // `pointercancel` : le fantôme resterait figé à l'écran. On l'étouffe.
      const onNativeDrag = (drag: DragEvent) => drag.preventDefault();
      const finish = (drop: boolean, at?: { x: number; y: number }) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("blur", onCancel);
        window.removeEventListener("dragstart", onNativeDrag, { capture: true });
        if (!started) return;
        document.body.classList.remove("ohb-roster-dragging");
        setDragging(null);
        // Le `click` qui suit le relâchement irait ouvrir le fil de la ligne
        // qu'on vient de déposer : il n'a pas été demandé. Il part dans la
        // même tâche que le `pointerup` ; s'il ne vient pas (relâché hors de
        // tout élément cliquable), le garde se désarme avant le clic suivant.
        const swallowClick = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallowClick, { capture: true }), 0);
        if (!drop || !at) return;
        const target = dropTargetAt(at.x, at.y, row);
        if (target.over) onDropRef.current(row, target.over, target.slot);
      };
      const onUp = (up: PointerEvent) => finish(true, { x: up.clientX, y: up.clientY });
      const onCancel = () => finish(false);
      const onKey = (key: KeyboardEvent) => {
        if (key.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
      window.addEventListener("blur", onCancel);
      window.addEventListener("dragstart", onNativeDrag, { capture: true });
    },
    [],
  );

  return (
    <RosterDragContext.Provider value={{ dragging, pointerDownFor: enabled ? pointerDownFor : null }}>
      {children}
      {dragging ? <DragGhost state={dragging} /> : null}
    </RosterDragContext.Provider>
  );
}

/**
 * La vignette qui suit le pointeur, la « Chef Otaku » de Grok Bot : le
 * visage, le nom dessous, et rien d'autre, sur une petite carte de 80 px
 * (fond `popover` : blanc en clair, gris anthracite en sombre). Ancrée en bas
 * à droite de la pointe du curseur, comme le fantôme natif : centrée sur le
 * curseur, elle recouvrait la ligne visée, son nom et le trait d'insertion :
 * on ne voyait plus où l'on déposait. Près d'un bord de la fenêtre (le tiroir
 * mobile fait 393 px de large, le bas est l'indicateur d'accueil), elle bascule
 * de l'autre côté du curseur plutôt que de sortir de l'écran.
 */
function ghostPosition(x: number, y: number): { left: number; top: number } {
  const maxLeft = window.innerWidth - GHOST_SIZE - GHOST_MARGIN;
  const maxTop = window.innerHeight - GHOST_SIZE - GHOST_MARGIN;
  const right = x + GHOST_OFFSET;
  const below = y + GHOST_OFFSET;
  const left = right > maxLeft ? Math.max(GHOST_MARGIN, x - GHOST_OFFSET - GHOST_SIZE) : right;
  const top = below > maxTop ? Math.max(GHOST_MARGIN, y - GHOST_OFFSET - GHOST_SIZE) : below;
  return { left, top };
}

function DragGhost({ state }: { state: DragState }) {
  const name = state.row.kind === "bot" ? state.row.bot.name : state.row.group.name;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[130] flex w-20 flex-col items-center gap-1.5 rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-border/60"
      style={ghostPosition(state.x, state.y)}
    >
      {state.row.kind === "bot" ? (
        <BotFace name={state.row.bot.name} seed={state.row.bot.id} face={state.row.bot.face} className="size-10" />
      ) : (
        <GroupFaceStack members={state.row.group.members} size="size-6" className="size-10 justify-center" />
      )}
      <span className="max-w-full truncate text-[11px] leading-tight font-medium">{name}</span>
    </div>,
    document.body,
  );
}
