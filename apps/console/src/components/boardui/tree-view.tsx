import { createContext, useContext, useState } from "react";
import type { ComponentProps, ComponentType, ContextType, KeyboardEventHandler, ReactNode, Ref } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { RiArrowRightSLine, RiFileLine, RiFolder3Line, RiFolderOpenLine } from "@remixicon/react";
import {
  Button as AriaButton,
  CollectionRendererContext,
  DefaultCollectionRenderer,
  Tree as AriaTree,
  TreeItem as AriaTreeItem,
  TreeItemContent,
  TreeStateContext,
  useLocale,
} from "react-aria-components";
import type {
  Key,
  TreeProps as AriaTreeProps,
  TreeItemProps as AriaTreeItemProps,
} from "react-aria-components";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * Le Tree View de BoardUI (boardui.com/components/tree-view), porté depuis son
 * registre (`www.boardui.com/r/tree-view.json`) : même balisage, mêmes jetons,
 * mêmes guides. Seuls les imports changent : `cn` du ui-kit pour `cx`, le sens
 * de lecture lu sur `useLocale` (le `useDirection` de BoardUI fait de même), et
 * `MENU_ITEM_ACTIVE` recopié de ses styles de menu. React Aria tient
 * l'ouverture, la sélection, la recherche au clavier et la navigation selon la
 * langue ; `motion` anime l'ouverture des branches.
 */

/** Le fond d'une rangée survolée ou choisie (`menu-styles.ts` de BoardUI). */
const MENU_ITEM_ACTIVE = "bg-dropdown-item-hover-background";

/**
 * Ajout openedbot : l'arbre accroché au tronc d'un bloc parent (l'activité d'un
 * tour). Ses rangées descendent d'un niveau et celles du premier reçoivent le
 * coude d'un enfant ; `continue` prolonge le tronc sous la dernière, `end` le
 * ferme sur son coude.
 */
type TreeRail = "continue" | "end";
const TreeRailContext = createContext<TreeRail | null>(null);

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface TreeViewProps<T extends object> extends AriaTreeProps<T> {
  /** Rangées de 36 px en `md`, 32 px en `sm`. */
  size?: "sm" | "md";
  /** Les troncs et les coudes qui relient les rangées imbriquées. */
  showGuides?: boolean;
  /**
   * Ajout openedbot, absent de BoardUI : `false` ouvre et ferme les branches sans
   * animation. Dans un fil accroché à son bas, les 280 ms de hauteur et de
   * flou faisaient glisser toute la conversation sous le pointeur.
   */
  animated?: boolean;
  /** Ajout openedbot, voir `TreeRail`. Absent, l'arbre est sa propre racine. */
  rail?: TreeRail | null;
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Un arbre pour des contenus imbriqués. Donner un `aria-label` (ou
 * `aria-labelledby`) et des identifiants d'éléments stables et uniques.
 * L'arbre grandit avec son contenu et laisse le défilement à la page.
 */
export function TreeView<T extends object>({
  size = "md",
  showGuides = true,
  animated = true,
  rail = null,
  selectionMode = "single",
  renderEmptyState = () => "No items.",
  className,
  onKeyDownCapture,
  ref,
  ...props
}: TreeViewProps<T>) {
  const { direction } = useLocale();
  const parentRenderer = useContext(CollectionRendererContext);
  const renderer = animated && parentRenderer === DefaultCollectionRenderer && !props.dragAndDropHooks
    ? TREE_VIEW_RENDERER
    : parentRenderer;

  return (
    <div
      className="contents"
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== (direction === "rtl" ? "ArrowLeft" : "ArrowRight")) return;
        const row = event.target;
        if (!(row instanceof HTMLElement) || row.getAttribute("role") !== "row" || row.getAttribute("aria-expanded") !== "true") return;

        // React Aria ouvre les branches fermées et remonte au parent. Ce qui
        // manque : avancer dans une branche déjà ouverte, en sautant les
        // rangées désactivées. Le focus sur l'enfant met aussi à jour React Aria.
        const level = Number(row.getAttribute("aria-level"));
        const tree = row.closest('[role="treegrid"]');
        const rows = Array.from(tree?.querySelectorAll<HTMLElement>('[role="row"][data-key]') ?? [])
          .filter((item) => item.closest('[role="treegrid"]') === tree && !item.closest("[data-tree-view-exiting]"));
        for (let index = rows.indexOf(row) + 1; index < rows.length; index++) {
          const child = rows[index]!;
          if (Number(child.getAttribute("aria-level")) <= level) break;
          if (child.getAttribute("aria-disabled") !== "true") {
            event.preventDefault();
            event.stopPropagation();
            child.focus();
            return;
          }
        }
      }}
    >
      <TreeRailContext.Provider value={rail}>
      <CollectionRendererContext.Provider value={renderer}>
        <AriaTree
          {...props}
          ref={ref}
          selectionMode={selectionMode}
          data-size={size}
          data-show-guides={showGuides}
          renderEmptyState={renderEmptyState}
          className={(state) => cn(
            "group/tree-view flex w-full min-w-0 flex-col rounded-3xl border border-border-button-default bg-background-primary-default p-2 outline-none",
            renderer === TREE_VIEW_RENDERER ? "gap-0" : "gap-0.5",
            "data-[empty]:px-4 data-[empty]:py-8 data-[empty]:text-center data-[empty]:text-body-regular data-[empty]:text-text-tertiary",
            "data-[focus-visible]:ring-2 data-[focus-visible]:ring-border-focus-ring",
            typeof className === "function" ? className(state) : className,
          )}
        />
      </CollectionRendererContext.Provider>
      </TreeRailContext.Provider>
    </div>
  );
}

export interface TreeViewItemProps<T extends object = object>
  extends Omit<AriaTreeItemProps<T>, "textValue" | "children"> {
  /** Le libellé visible, aussi le nom accessible et la clé de recherche au clavier. */
  label: string;
  textValue?: string;
  /** Un dossier pour une branche, un fichier pour une feuille par défaut. null le masque. */
  icon?: IconComponent | null;
  /** L'icône d'une branche ouverte, si elle diffère. */
  expandedIcon?: IconComponent;
  iconClassName?: string;
  /** A face or other row artwork beside the tree icon. */
  leadingContent?: ReactNode;
  /** A second, muted line below the visible label. */
  description?: ReactNode;
  /** Une métadonnée ou un badge en bout de rangée. */
  trailingContent?: ReactNode;
  /** Des `TreeViewItem` imbriqués, ou une `TreeViewCollection`. */
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

export function TreeViewItem<T extends object = object>({
  label,
  textValue = label,
  icon,
  expandedIcon,
  iconClassName,
  leadingContent,
  description,
  trailingContent,
  children,
  className,
  style,
  ref,
  ...props
}: TreeViewItemProps<T>) {
  const { direction } = useLocale();
  // Accroché à un tronc parent, l'arbre se pose un niveau plus bas.
  const rail = useContext(TreeRailContext);
  const shift = rail ? 1 : 0;

  return (
    <AriaTreeItem
      {...props}
      ref={ref}
      textValue={textValue}
      style={(state) => ({
        paddingInlineStart: `calc(0.5rem + ${(state.level - 1 + shift)} * 1.25rem)`,
        ...(typeof style === "function" ? style(state) : style),
      })}
      className={(state) => cn(
        "relative flex min-h-9 min-w-0 cursor-pointer items-center gap-2 rounded-xl pe-2 text-body-regular text-text-primary outline-none",
        description != null && "min-h-[52px] py-1.5",
        "transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none",
        "group-data-[size=sm]/tree-view:min-h-8 group-data-[size=sm]/tree-view:text-body-2-regular",
        (state.isHovered || state.isPressed || state.isFocusVisible) && !state.isDisabled && MENU_ITEM_ACTIVE,
        state.isSelected && MENU_ITEM_ACTIVE,
        state.isFocusVisible && "ring-2 ring-inset ring-border-focus-ring",
        state.isDisabled && "cursor-not-allowed text-text-placeholder",
        typeof className === "function" ? className(state) : className,
      )}
    >
      <TreeItemContent>
        {({ hasChildItems, isExpanded, isDisabled, level, state, id }) => {
          const Icon = icon === null ? null : (
            isExpanded && expandedIcon
              ? expandedIcon
              : icon ?? (hasChildItems ? (isExpanded ? RiFolderOpenLine : RiFolder3Line) : RiFileLine)
          );

          return (
            <>
              <TreeGuides state={state} id={id} level={level} expanded={hasChildItems && isExpanded} branchWidth={hasChildItems ? 12 : 16} direction={direction} rail={rail} />
              <span className="flex shrink-0 items-center gap-1">
                {hasChildItems ? (
                  <AriaButton
                    slot="chevron"
                    isDisabled={isDisabled}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-icon-tertiary outline-none transition-colors hover:text-foreground-icon-primary data-[focus-visible]:ring-2 data-[focus-visible]:ring-border-focus-ring"
                  >
                    <RiArrowRightSLine
                      aria-hidden
                      className={cn(
                        "size-4 opacity-50 transition-transform duration-150 motion-reduce:transition-none",
                        isExpanded ? "rotate-90" : direction === "rtl" && "rotate-180",
                      )}
                    />
                  </AriaButton>
                ) : (
                  // Une feuille a besoin de moins de place : les icônes de
                  // premier niveau restent alignées, les feuilles imbriquées
                  // se resserrent pour garder leur coude compact.
                  <span aria-hidden className={cn("h-5 shrink-0", level + shift > 1 ? "w-2" : "w-5")} />
                )}
                {Icon && <Icon aria-hidden className={cn(
                  "size-4 shrink-0 opacity-50",
                  hasChildItems ? "text-foreground-icon-primary" : "text-foreground-icon-secondary",
                  iconClassName,
                )} />}
              </span>
              {leadingContent != null && <span className="shrink-0">{leadingContent}</span>}
              <span className={cn("min-w-0 flex-1 text-start", description == null && "truncate")}>
                <bdi className="block truncate">{label}</bdi>
                {description != null && <span className="block truncate text-caption-1-regular text-text-tertiary">{description}</span>}
              </span>
              {trailingContent != null && (
                <span className="ms-auto shrink-0 text-caption-1-regular text-text-tertiary">{trailingContent}</span>
              )}
            </>
          );
        }}
      </TreeItemContent>
      {children}
    </AriaTreeItem>
  );
}

/** `Collection` pour un arbre tiré de données, rendu récursivement. */
export { Collection as TreeViewCollection } from "react-aria-components";

const TREE_VIEW_RENDERER = {
  ...DefaultCollectionRenderer,
  CollectionRoot: AnimatedTreeCollection,
};

function AnimatedTreeCollection({ collection, ...props }: ComponentProps<typeof DefaultCollectionRenderer.CollectionRoot>) {
  const state = useContext(TreeStateContext);
  if (!state) return <DefaultCollectionRenderer.CollectionRoot collection={collection} {...props} />;

  return (
    <AnimatePresence initial={false}>
      {Array.from(collection).filter((node) => node.type !== "content").map((node) => (
        <AnimatedTreeRow key={node.key} state={state}>
          {node.render?.(node)}
        </AnimatedTreeRow>
      ))}
    </AnimatePresence>
  );
}

type TreeState = NonNullable<ContextType<typeof TreeStateContext>>;

function TreeGuides({ state, id, level, expanded, branchWidth, direction, rail }: {
  state: TreeState;
  id: Key;
  level: number;
  expanded: boolean;
  branchWidth: number;
  direction: "ltr" | "rtl";
  rail: TreeRail | null;
}) {
  const node = state.collection.getItem(id);
  if (!node) return null;

  // Sur un tronc parent, tout se dessine un niveau plus bas, et la dernière
  // rangée du premier niveau a encore une suite quand ce tronc continue.
  const shift = rail ? 1 : 0;
  const hasNext = (item: { nextKey?: Key | null }, itemLevel: number) =>
    item.nextKey != null || (rail === "continue" && itemLevel === 1);

  // Un descendant porte le tronc d'un niveau supérieur seulement si son
  // ancêtre a encore un frère à venir : la ligne reste continue à travers une
  // branche ouverte, et le coude du dernier enfant ferme ce niveau.
  const continuingLevels: number[] = [];
  let ancestor = node.parentKey != null ? state.collection.getItem(node.parentKey) : null;
  let ancestorLevel = level - 1;
  while (ancestor) {
    if (ancestor.type === "item") {
      if (ancestorLevel + shift > 1 && hasNext(ancestor, ancestorLevel)) continuingLevels.push(ancestorLevel + shift - 2);
      ancestorLevel--;
    }
    ancestor = ancestor.parentKey != null ? state.collection.getItem(ancestor.parentKey) : null;
  }

  const axis = (depth: number) => `calc(1.125rem + ${depth} * 1.25rem)`;

  return (
    <span aria-hidden data-tree-view-guides className="pointer-events-none absolute inset-0 text-foreground-icon-quaternary group-data-[show-guides=false]/tree-view:hidden">
      {continuingLevels.map((depth) => (
        <span key={depth} data-tree-view-trunk className="absolute -inset-y-px w-px bg-current" style={{ insetInlineStart: axis(depth) }} />
      ))}
      {level + shift > 1 && (
        <span data-tree-view-branch className="absolute -inset-y-px" style={{ insetInlineStart: axis(level + shift - 2), width: branchWidth }}>
          <span className="absolute start-0 top-0 w-px bg-current" style={{ bottom: "calc(50% + 6px)" }} />
          <svg
            width={branchWidth}
            height="7"
            viewBox={`0 0 ${branchWidth} 7`}
            fill="none"
            className={cn("absolute start-0", direction === "rtl" && "-scale-x-100")}
            style={{ top: "calc(50% - 6px)" }}
          >
            <path d={`M0.5 0 Q0.5 6 6.5 6 H${branchWidth - 0.5}`} stroke="currentColor" strokeWidth="1" />
          </svg>
          {hasNext(node, level) && (
            <span data-tree-view-tail className="absolute start-0 bottom-0 w-px bg-current" style={{ top: "calc(50% - 6px)" }} />
          )}
        </span>
      )}
      {expanded && (
        <span data-tree-view-bridge className="absolute -bottom-px w-px bg-current" style={{ insetInlineStart: axis(level + shift - 1), top: "calc(50% + 8px)" }} />
      )}
    </span>
  );
}

/**
 * Ajout openedbot : une étape qui n'est pas un arbre (recherche, phrase, décision),
 * accrochée au même tronc qu'un `TreeView` en `rail`, avec le même coude
 * BoardUI. Le tronc passe à 7 px du bord et le contenu commence à 29 px, là où
 * un arbre en `rail` décalé de -11 px pose ses glyphes. `anchor` est le milieu
 * de la première ligne du contenu, `gap` l'écart avec l'étape voisine, que le
 * tronc franchit.
 */
export function TreeRailStep({ last, anchor = 14, gap = 8, children }: {
  last: boolean;
  anchor?: number;
  gap?: number;
  children: ReactNode;
}) {
  const { direction } = useLocale();
  return (
    <div data-tree-rail-step="" className="relative min-w-0 ps-[29px]">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 start-[7px] w-4 text-foreground-icon-quaternary">
        <span className="absolute start-0 w-px bg-current" style={{ top: -gap, height: anchor - 6 + gap }} />
        <svg
          width="16"
          height="7"
          viewBox="0 0 16 7"
          fill="none"
          className={cn("absolute start-0", direction === "rtl" && "-scale-x-100")}
          style={{ top: anchor - 6 }}
        >
          <path d="M0.5 0 Q0.5 6 6.5 6 H15.5" stroke="currentColor" strokeWidth="1" />
        </svg>
        {last ? null : <span className="absolute start-0 w-px bg-current" style={{ top: anchor - 6, bottom: -gap }} />}
      </span>
      {children}
    </div>
  );
}

function AnimatedTreeRow({ state, children }: { state: TreeState; children: ReactNode }) {
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();
  const [lastPresentState, setLastPresentState] = useState(state);
  if (isPresent && lastPresentState !== state) setLastPresentState(state);

  // La rangée qui s'efface garde sa dernière collection le temps du fondu.
  // L'arbre vivant l'a déjà retirée de la navigation au clavier : ce reste
  // visuel est inerte.
  return (
    <motion.div
      role="presentation"
      className="relative min-w-0 shrink-0 overflow-hidden"
      data-tree-view-exiting={!isPresent || undefined}
      aria-hidden={!isPresent || undefined}
      inert={!isPresent}
      initial={reduceMotion ? false : { height: 0, paddingTop: 0, paddingBottom: 0, opacity: 0, y: -4, filter: "blur(4px)" }}
      animate={{ height: "auto", paddingTop: 1, paddingBottom: 1, opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ height: 0, paddingTop: 0, paddingBottom: 0, opacity: 0, y: reduceMotion ? 0 : -4, filter: reduceMotion ? "blur(0px)" : "blur(4px)" }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <TreeStateContext.Provider value={isPresent ? state : lastPresentState}>
        {children}
      </TreeStateContext.Provider>
    </motion.div>
  );
}
