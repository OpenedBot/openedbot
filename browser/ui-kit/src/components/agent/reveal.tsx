import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * L'entrée d'une rangée dans un journal d'agent : la boîte s'ouvre à la
 * hauteur de son contenu pendant que celui-ci monte, se dévoile et se
 * dépixellise.
 *
 * L'ouverture passe par `grid-template-rows: 0fr -> 1fr`, la technique de
 * l'amont pour ses rangées. Elle évite de mesurer une hauteur en script :
 * une piste de grille s'interpole, `height: auto` non. La rangée suit donc
 * aussi son contenu quand le texte se réenroule, fenêtre redimensionnée ou
 * police chargée tardivement.
 *
 * Les fondus tournent sur une horloge plus courte que le mouvement : la
 * rangée est entièrement lisible avant d'avoir fini de se poser.
 */

const GROW_MS = 320;
const FADE_MS = 240;
/** De combien la rangée monte en se dévoilant. */
const LIFT_PX = 6;
/** Le flou de départ, en pixels. */
const BLUR_PX = 2;

export type RevealProps = {
  children: React.ReactNode;
  /** Décalage du départ, pour mettre en escalier une série de rangées. */
  delayMs?: number;
  /** Rendu sans animation, pour un journal déjà clos qu'on relit. */
  instant?: boolean;
  className?: string;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Reveal({ children, delayMs = 0, instant = false, className }: RevealProps) {
  // Premier rendu fermé sauf demande explicite : serveur et client doivent
  // produire le même balisage, l'ouverture n'a lieu qu'ensuite.
  const [open, setOpen] = React.useState(instant);

  React.useEffect(() => {
    if (open) return;
    if (prefersReducedMotion()) {
      setOpen(true);
      return;
    }
    const start = window.setTimeout(() => setOpen(true), delayMs);
    return () => window.clearTimeout(start);
  }, [delayMs, open]);

  return (
    <div
      className={cn("grid", className)}
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        filter: open ? "blur(0px)" : `blur(${BLUR_PX}px)`,
        transform: open ? "none" : `translateY(${LIFT_PX}px)`,
        transition: instant
          ? undefined
          : `grid-template-rows ${GROW_MS}ms ease-out, opacity ${FADE_MS}ms ease-out, filter ${FADE_MS}ms ease-out, transform ${GROW_MS}ms ease-out`,
      }}
    >
      {/* `min-h-0` est ce qui laisse la piste descendre à zéro : sans lui la
          grille garde la hauteur minimale du contenu et rien ne s'ouvre. */}
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
