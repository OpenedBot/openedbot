import { RiArrowRightSLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";

/**
 * L'intitulé d'une liste au bureau, l'en-tête de section de Grok Bot
 * (`sectionHeader`) : 30 px, marges 8 / 8 / 6, texte 13/18 gris, graisse
 * normale, aligné sur le texte des lignes (8 px).
 */
export const SECTION_LABEL_DENSE = "flex h-[30px] shrink-0 items-center px-2 pt-2 pb-1.5 text-[13px] leading-[18px] font-normal text-text-section-label";

/** En-tête de dossier : clic pour replier. Le hover souris est le même cran que les tuiles. */
export function BoardSectionHeader({
  label,
  collapsed,
  count,
  onToggle,
  onPointerDown,
  dense = false,
}: {
  label: string;
  collapsed: boolean;
  count: number;
  onToggle: () => void;
  /** Glisser l'en-tête réordonne les sections ; absent pour « Non assigné ». */
  onPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  dense?: boolean;
}) {
  if (dense) {
    // Bureau : l'intitulé de la maquette, toujours repliable. Le chevron suit
    // le nom au lieu de le précéder, pour que le nom reste aligné sur les
    // lignes ; il reste visible (atténué), plein au survol, au focus ou replié.
    return (
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        onPointerDown={onPointerDown}
        className={cn(SECTION_LABEL_DENSE, "group w-full min-w-0 cursor-pointer gap-0.5 rounded-lg outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring")}
      >
        <span className="min-w-0 truncate text-left">{label}</span>
        <RiArrowRightSLine
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-[transform,opacity]",
            collapsed ? "opacity-100" : "rotate-90 opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        />
        {collapsed ? <span className="ms-auto tabular-nums">{count}</span> : null}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      onPointerDown={onPointerDown}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 rounded-xl px-2 text-body-2-medium text-text-tertiary outline-none hover:bg-background-tertiary-hover hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <RiArrowRightSLine className={cn("size-4 shrink-0 transition-transform", !collapsed && "rotate-90")} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {collapsed ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
