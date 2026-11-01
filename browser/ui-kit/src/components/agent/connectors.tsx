import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Les traits qui relient les rangées d'un journal d'agent à leur colonne.
 * Le même dessin sert au journal de tâches et à la trace de recherche : le
 * garder en un seul endroit évite que les deux dérivent l'un de l'autre.
 */

/**
 * Le coude d'une rangée : le trait descend, s'arrondit vers la droite, et se
 * prolonge vers la rangée suivante tant qu'il en reste une.
 */
export function Branch({ last, className }: { last: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-y-0 left-0 w-3 text-muted-foreground/35", className)}
    >
      <svg width="12" height="15" viewBox="0 0 12 15" fill="none" className="absolute top-0 left-0">
        <path d="M0.5 0 V8 Q0.5 14 6.5 14 H11.5" stroke="currentColor" strokeWidth="1" />
      </svg>
      {last ? null : (
        <span className="absolute left-0 w-px origin-top bg-current" style={{ top: 8, bottom: 0 }} />
      )}
    </span>
  );
}

/**
 * La colonne du tronc, comptée depuis le bord du bloc. C'est la marge gauche
 * du conteneur de rangées (le `ml-2` du journal de tâches), soit le centre
 * d'un glyphe de tête `size-4`. `Stem` et la verticale de `Branch` doivent
 * tomber sur cette seule colonne : un tronc et un coude décalés d'un pixel se
 * lisent comme deux traits cassés.
 */
export const TRUNK_LEFT = 8;

/** Place d'un bloc dans la trace d'un tour ; seul, un bloc n'a pas de tronc. */
export type RailPosition = "first" | "middle" | "last";

/**
 * Le glyphe de tête d'un bloc se centre à cette hauteur (±6 px selon le
 * bloc). Le tronc s'arrête DANS le masque du glyphe, jamais à un pixel exact :
 * une tête un peu plus haute ou plus basse ne laisse pas de trait pendant.
 */
const RAIL_GLYPH_CENTER = 12;

/**
 * Un bloc de la trace d'un tour (plan, recherche, outils, autorisation) et le
 * tronc qui le relie à ses voisins, sur la colonne `TRUNK_LEFT`. Le tronc
 * traverse l'écart entre deux blocs (`gap`, celui du conteneur) et passe sous
 * les glyphes de tête, qui le masquent de leur fond.
 */
export function TrailItem({
  position,
  gap,
  children,
  className,
}: {
  position: RailPosition | null | undefined;
  /** L'écart vertical entre ce bloc et le suivant, en pixels. */
  gap: number;
  children: ReactNode;
  className?: string;
}) {
  const rail = position === "last"
    ? { top: 0, height: RAIL_GLYPH_CENTER }
    : position
      ? { top: position === "first" ? RAIL_GLYPH_CENTER : 0, bottom: -gap }
      : null;
  return (
    <div data-trail={position ?? undefined} className={cn("relative min-w-0", className)}>
      {rail ? (
        <span
          aria-hidden
          className="pointer-events-none absolute w-px bg-current text-muted-foreground/35"
          style={{ left: TRUNK_LEFT, ...rail }}
        />
      ) : null}
      {children}
    </div>
  );
}

/** Le raccord vertical entre une rangée et la liste qu'elle ouvre. */
export function Stem({ height }: { height: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute w-px origin-top bg-current text-muted-foreground/35"
      style={{ top: -height, height, left: TRUNK_LEFT }}
    />
  );
}
