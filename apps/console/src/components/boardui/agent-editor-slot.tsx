import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";

/** Largeur de l'éditeur à droite du fil (gouttière de 16 px comprise). */
export const EDITOR_SLOT_WIDTH = 356;
/** Entrée et sortie du panneau ; la colonne du fil reprend sa place après. */
export const EDITOR_FADE_MS = 180;

/**
 * La place de l'éditeur à droite du fil, en ligne (au-delà de 1100 px).
 *
 * La largeur ne s'anime PAS : animée (0 -> 356 px en 300 ms), elle faisait
 * rétrécir la colonne du fil image par image, et chaque image remettait en
 * page les réponses (retours à la ligne, bulles qui grandissent, fil épinglé
 * en bas qui remonte, contenu recentré). À l'ouverture, la place est prise
 * d'un coup (une seule remise en page), puis le panneau entre en fondu et
 * glisse de 12 px. À la fermeture, le panneau sort d'abord, puis la place se
 * libère d'un coup.
 */
export function InlineEditorSlot({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [reserved, setReserved] = useState(visible);
  const [shown, setShown] = useState(visible);

  // Avant le paint : la place et le panneau transparent arrivent ensemble.
  useLayoutEffect(() => {
    if (visible) setReserved(true);
  }, [visible]);

  useEffect(() => {
    if (visible) {
      // Deux images : l'opacité 0 doit avoir été calculée (et peinte) avant
      // de passer à 1, sans quoi la transition ne part pas.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setShown(true));
      });
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setReserved(false), EDITOR_FADE_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <div
      data-editor-slot={reserved ? "open" : "closed"}
      className="min-h-0 shrink-0 overflow-hidden"
      style={{ width: reserved ? EDITOR_SLOT_WIDTH : 0 }}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div
        className="h-full ps-4 transition-[opacity,transform] ease-out motion-reduce:transition-none"
        style={{ width: EDITOR_SLOT_WIDTH, transitionDuration: `${EDITOR_FADE_MS}ms`, opacity: shown ? 1 : 0, transform: shown ? "none" : "translateX(12px)" }}
      >
        {children}
      </div>
    </div>
  );
}
