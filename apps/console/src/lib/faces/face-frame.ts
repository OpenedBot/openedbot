import type { BotFrame } from "@openedbot/browser-face/bloub/engine";

/**
 * Ce que partagent les visages qui ne rendent leur pose qu'en attributs : la
 * pastille (`bloub-bot.tsx`) et le galet du foyer (`salon-orbit.tsx`). Un
 * module à part : un fichier de composant qui exporte autre chose que des
 * composants perd le Fast Refresh.
 */

/** Écrire un attribut identique invalide quand même le rendu : on s'en abstient. */
export function poser(node: Element, nom: string, valeur: string): void {
  if (node.getAttribute(nom) !== valeur) node.setAttribute(nom, valeur);
}

/**
 * Deux images ont-elles le même ARBRE (mêmes nœuds, mêmes formes) et ne
 * diffèrent-elles que par la pose ?
 *
 * C'est la question qui décide si une image passe par React ou par quelques
 * `setAttribute`. En repos la réponse est toujours oui : le contour est gardé
 * par le moteur (identité de chaîne), la forme des yeux ne change pas, et il
 * n'y a ni points ni anneaux. Ne bougent que la transformation du corps et les
 * matrices des yeux, que React ne rend donc pas du tout, sans quoi son vdom
 * garderait une valeur périmée et sauterait la mise à jour suivante.
 *
 * Points et anneaux, eux, ne survivent pas à ce traitement : leurs coordonnées
 * sont dans le JSX. Hors repos (l'orbite du galet), on rend par React plutôt
 * que de les figer en silence.
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
