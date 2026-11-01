import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Le motion du fil et du composer, relevé sur Grok Bot 0.78.1 le 30-10
 * (capture image par image d'un envoi réel, `reports/grok-bot/2026_10_30`).
 * Les valeurs sont les siennes ; les feuilles de style reprennent les mêmes
 * (`thread-timeline.css`, `agent-activity.css`).
 */

/** Le ressort de Grok (composer pilule → carte, 300 ms) : un `linear()` échantillonné. */
export const GROK_SPRING =
  "linear(0 0%, 0.01588 2%, 0.05618 4%, 0.11201 6%, 0.1768 8%, 0.2458 10%, 0.31562 12%, 0.38392 14%, 0.44914 16%, 0.51029 18%, 0.56683 20%, 0.61852 22%, 0.66534 24%, 0.70743 26%, 0.74501 28%, 0.77838 30%, 0.80788 32%, 0.83383 34%, 0.85658 36%, 0.87645 38%, 0.89376 40%, 0.92183 44%, 0.94282 48%, 0.95838 52%, 0.96984 56%, 0.97823 60%, 0.98435 64%, 0.98878 68%, 0.99198 72%, 0.99594 80%, 0.99829 90%, 1 100%)";
export const GROK_SPRING_MS = 300;

/** Un message qui arrive monte de 12 px, sans fondu : 240 ms. */
export const ROW_ENTER_MS = 240;
export const ROW_ENTER_EASING = "cubic-bezier(0.23, 1, 0.32, 1)";
export const ROW_ENTER_OFFSET_PX = 12;

/** La marque d'activité qui s'en va : échelle 0,92 et fondu, 140 ms (`bubbleExiting`). */
export const TYPING_EXIT_MS = 140;

/** Ce qui suit une rangée ajoutée sans en faire un ajout « au milieu ». */
const TRAILING_CHROME = "[data-thread-scroll-anchor], [data-thread-outgoing], [data-thread-exit-ghost]";
/** Une rangée de message ; un séparateur de date ou un repère n'anime pas. */
const MESSAGE_ROW = "[data-user-bubble], [data-assistant-layout], [data-assistant-response], [data-room-answer], [data-inbound-from]";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function isMessageRow(node: Element): boolean {
  return node.matches(MESSAGE_ROW) || node.querySelector(MESSAGE_ROW) !== null;
}

function userBubbleText(node: Element): string | null {
  const bubble = node.matches("[data-user-bubble]") ? node : node.querySelector("[data-user-bubble]");
  return bubble ? (bubble.textContent ?? "").trim() : null;
}

/**
 * Fait monter chaque message ajouté AU BOUT du fil (envoi, réponse), comme
 * Grok. Au niveau du DOM, pas du rendu : les tours sont mis en cache
 * (`turnNodeCache`), et un drapeau « nouveau » dans leurs props invaliderait
 * ce cache.
 *
 * Ne bougent pas :
 * - le premier rendu d'un fil (l'observateur arrive après lui) et un
 *   changement de fil (`threadKey`, l'observateur est réarmé) ;
 * - l'historique plus ancien, ajouté AVANT des rangées déjà là ;
 * - la rangée enregistrée qui remplace la bulle optimiste
 *   (`data-thread-outgoing`) : même texte, la bulle a déjà monté.
 */
export function useThreadRowEnter(content: RefObject<HTMLElement | null>, threadKey: string | null) {
  useEffect(() => {
    const root = content.current;
    if (!root || typeof MutationObserver === "undefined" || prefersReducedMotion()) return;
    // Le texte de la dernière bulle optimiste vue : sa remplaçante ne rejoue pas.
    let outgoingText: string | null = null;
    const observer = new MutationObserver((records) => {
      const added = new Set<Element>();
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) added.add(node);
      }
      for (const node of added) {
        let next = node.nextElementSibling;
        let appended = true;
        while (next) {
          if (!added.has(next) && !next.matches(TRAILING_CHROME)) {
            appended = false;
            break;
          }
          next = next.nextElementSibling;
        }
        if (!appended || !isMessageRow(node)) continue;
        const text = userBubbleText(node);
        if (node.matches("[data-thread-outgoing]")) {
          outgoingText = text;
        } else if (text !== null && text === outgoingText) {
          outgoingText = null;
          continue;
        }
        if (typeof (node as HTMLElement).animate !== "function") continue;
        (node as HTMLElement).animate(
          [{ transform: `translateY(${ROW_ENTER_OFFSET_PX}px)` }, { transform: "none" }],
          { duration: ROW_ENTER_MS, easing: ROW_ENTER_EASING },
        );
      }
    });
    observer.observe(root, { childList: true });
    return () => observer.disconnect();
  }, [content, threadKey]);
}

/**
 * Une marque qui quitte le fil s'efface au lieu de disparaître d'un coup :
 * au démontage, sa copie inerte prend sa place le temps de la sortie de
 * Grok. La rangée qui la remplace entre pendant ce temps, au même endroit.
 *
 * La copie reste dans le flux (la liste n'est pas positionnée : en absolu,
 * elle se caserait hors du défilement) mais n'y occupe rien : sa marge basse
 * rend sa hauteur, sa marge haute et l'écart de la liste.
 *
 * Le nettoyage d'un effet de mise en page passe avant le retrait du nœud :
 * il est encore à sa place, on y lit sa taille et son voisin d'avant. La
 * copie n'entre qu'une micro-tâche plus tard, si le nœud a vraiment quitté
 * le DOM : le double montage de `StrictMode` (dev) nettoie puis remonte sur
 * place, sans rien retirer.
 */
export function useExitGhost(node: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = node.current;
    return () => {
      const parent = element?.parentElement;
      if (!element || !parent || !element.isConnected || prefersReducedMotion()) return;
      if (typeof element.animate !== "function") return;
      const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0;
      const gap = Number.parseFloat(getComputedStyle(parent).rowGap) || 0;
      const height = element.offsetHeight;
      const previous = element.previousSibling;
      const next = element.nextSibling;
      const ghost = element.cloneNode(true) as HTMLElement;
      queueMicrotask(() => {
        if (element.isConnected || !parent.isConnected) return;
        ghost.setAttribute("data-thread-exit-ghost", "");
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("data-thread-thinking");
        for (const live of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
          live.removeAttribute("role");
          live.removeAttribute("id");
          // La copie ne rejoue pas l'entrée de l'original.
          live.style.animation = "none";
        }
        Object.assign(ghost.style, {
          marginBottom: `${-(marginTop + height + gap)}px`,
          pointerEvents: "none",
        });
        // Juste après le voisin d'avant : la rangée qui remplace la marque a
        // pu entrer à sa place, avant le voisin d'après.
        const before = previous?.parentNode === parent
          ? previous.nextSibling
          : next?.parentNode === parent ? next : null;
        parent.insertBefore(ghost, before);
        const animation = ghost.animate(
          [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.92)" }],
          { duration: TYPING_EXIT_MS, easing: "ease", fill: "forwards" },
        );
        const remove = () => ghost.remove();
        animation.addEventListener("finish", remove, { once: true });
        animation.addEventListener("cancel", remove, { once: true });
      });
    };
  }, [node]);
}

/**
 * La pilule du composer qui devient carte : sa hauteur et son rayon (22 → 18)
 * suivent le ressort de Grok au lieu de sauter. Le contenu passe tout de
 * suite en carte ; le cadre le découpe le temps du ressort.
 */
export function animateComposerExpand(frame: HTMLElement, from: { height: number; radius: string }) {
  if (prefersReducedMotion() || typeof frame.animate !== "function") return;
  const toHeight = frame.getBoundingClientRect().height;
  if (!from.height || Math.abs(toHeight - from.height) < 1) return;
  const toRadius = getComputedStyle(frame).borderRadius;
  const previousOverflow = frame.style.overflow;
  frame.style.overflow = "clip";
  const animation = frame.animate(
    [
      { height: `${from.height}px`, borderRadius: from.radius || toRadius },
      { height: `${toHeight}px`, borderRadius: toRadius },
    ],
    { duration: GROK_SPRING_MS, easing: GROK_SPRING },
  );
  const restore = () => {
    frame.style.overflow = previousOverflow;
  };
  animation.addEventListener("finish", restore, { once: true });
  animation.addEventListener("cancel", restore, { once: true });
}
