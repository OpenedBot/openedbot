import type { BotFrame } from "@openedbot/browser-face/bloub/engine";

/**
 * What the faces that render their pose only as attributes share: the
 * chip (`bloub-bot.tsx`) and the home pebble (`salon-orbit.tsx`). A
 * separate module: a component file that exports something other than
 * components loses Fast Refresh.
 */

/** Writing an identical attribute still invalidates the render: we refrain. */
export function poser(node: Element, nom: string, valeur: string): void {
  if (node.getAttribute(nom) !== valeur) node.setAttribute(nom, valeur);
}

/**
 * Do two images have the same TREE (same nodes, same shapes) and
 * differ only by the pose?
 *
 * That is the question that decides whether an image goes through React or through a few
 * `setAttribute`. At rest the answer is always yes: the outline is kept
 * by the engine (string identity), the eye shape does not change, and there
 * are neither dots nor rings. Only the body transform and the
 * eye matrices move, which React therefore does not render at all, otherwise its vdom
 * would keep a stale value and skip the next update.
 *
 * Dots and rings do not survive that treatment: their coordinates
 * are in the JSX. Off rest (the pebble's orbit), we render through React rather
 * than freeze them in silence.
 */
export function memeArbre(a: BotFrame, b: BotFrame): boolean {
  if (a.dots.length > 0 || b.dots.length > 0) return false;
  if (a.arcs.length > 0 || b.arcs.length > 0) return false;
  return (
    a.bodyPath === b.bodyPath &&
    a.bodyAlpha === b.bodyAlpha &&
    a.dotsBehind === b.dotsBehind &&
    a.eyes.length === b.eyes.length &&
    (a.notch === null) === (b.notch === null) &&
    (a.notif === null) === (b.notif === null) &&
    a.eyes.every((eye, index) => eye.d === b.eyes[index]?.d)
  );
}
