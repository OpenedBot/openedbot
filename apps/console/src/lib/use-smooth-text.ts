import { useEffect, useRef, useState } from "react";
import { TextStreamAnimator, type AnimatorIo } from "@openedbot/browser-face/text-stream-animator";

/**
 * Le lissage du texte streamé, côté navigateur.
 *
 * La mécanique (`TextStreamAnimator`) vit dans le cœur, partagée avec le
 * mobile : le pipeline livre le texte par rafales (coalescing worker 100 ms +
 * poller SSE, mesuré : +90 à +230 caractères d'un coup), et sans lissage la
 * bulle avance par à-coups sur les deux clients. Ne reste ici que le branchement
 * React et l'horloge du navigateur.
 */
const browserIo: AnimatorIo = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

/** Ré-exportée : les tests de ce module pilotent l'animateur avec leur propre horloge. */
export { TextStreamAnimator };

/** Borne dure d'un rattrapage : run conclu, ou gros bloc reçu d'un coup. */
export const SMOOTH_CATCH_UP_MAX_MS = 300;

/**
 * Au-delà, un ajout n'est plus une rafale de flux (mesuré : +90 à +230
 * caractères) mais un bloc : la réponse complète livrée d'un coup, ou un
 * snapshot qui rattrape. Il se déroule dans `SMOOTH_CATCH_UP_MAX_MS`.
 */
export const SMOOTH_BLOCK_CHARS = 400;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function retargetSmoothText(
  animator: TextStreamAnimator,
  text: string,
  enabled: boolean,
  previouslyStreaming: boolean,
  reduceMotion = false,
): void {
  // Aucune animation sous `prefers-reduced-motion`.
  if (reduceMotion) {
    if (animator.currentText !== text || animator.targetText !== text) animator.jumpTo(text);
    return;
  }
  if (!enabled) {
    if (previouslyStreaming && text.startsWith(animator.currentText)) {
      // Run conclu : le retard restant se rattrape en un temps borné, il ne
      // s'ajoute pas au temps d'attente de la réponse.
      animator.targetText = text;
      if (animator.currentText !== text) animator.start(SMOOTH_CATCH_UP_MAX_MS);
    } else {
      animator.jumpTo(text);
    }
    return;
  }
  if (!text.startsWith(animator.targetText)) {
    animator.jumpTo(text);
    return;
  }
  const added = text.length - animator.targetText.length;
  animator.targetText = text;
  if (animator.currentText !== text) {
    animator.start(added > SMOOTH_BLOCK_CHARS ? SMOOTH_CATCH_UP_MAX_MS : undefined);
  }
}

/**
 * Rend une version lissée de `text` tant que `enabled` est vrai. Une bulle
 * montée en streaming s'anime depuis vide ; montée hors streaming (`enabled`
 * faux: run conclu, bulle historique) elle rend son texte tel quel,
 * immédiatement.
 */
export function useSmoothText(text: string, enabled: boolean): string {
  // Une bulle qui NAÎT en streaming part de vide : son premier fragment
  // s'anime aussi. Partir du texte monté laissait toute la première rafale
  // (voire une réponse courte entière) apparaître d'un bloc, puis geler
  // ~500 ms jusqu'à la rafale suivante (mesuré : pop de ~157 caractères).
  // Sous `prefers-reduced-motion`, le texte monté est rendu tel quel.
  const [startsEmpty] = useState(() => enabled && !prefersReducedMotion());
  const [displayedText, setDisplayedText] = useState(startsEmpty ? "" : text);
  const [animator] = useState(() => new TextStreamAnimator(startsEmpty ? "" : text, setDisplayedText, browserIo));
  const wasStreaming = useRef(enabled);

  useEffect(() => {
    const previouslyStreaming = wasStreaming.current;
    wasStreaming.current = enabled;
    // `run.completed` est souvent livré dans le même tick SSE que le dernier
    // fragment. La transition stream -> final finit son retard, mais en
    // `SMOOTH_CATCH_UP_MAX_MS` au plus : la réponse est déjà là.
    retargetSmoothText(animator, text, enabled, previouslyStreaming, prefersReducedMotion());
  }, [animator, enabled, text]);

  useEffect(() => () => animator.stop(), [animator]);

  return displayedText;
}
