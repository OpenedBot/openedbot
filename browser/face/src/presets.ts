import { pickBySeed, type BotFaceSpec } from "@openedbot/contracts-api";
import { COLORS, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPES } from "./bloub/skins";
import type { BotColor, BotShape } from "./bloub/skins";
import { DEFAULT_EXPRESSION, EXPRESSIONS } from "./bloub/expressions";
import type { BotExpression } from "./bloub/expressions";

/**
 * Le catalogue de visages classiques : celui de bloub (`./bloub/`, MIT,
 * Jérémy Perret), repris tel quel : 8 formes × 12 couleurs × 16 expressions
 * de repos, rendues par son moteur (`browser/face/src/bloub/engine.ts`).
 *
 * Les champs de `BotFaceSpec` gardent leurs noms historiques pour ne pas
 * toucher au contrat HTTP ni aux visages déjà en base : `palette` porte une
 * couleur bloub, `shape` une forme, `eyes` une expression. `mouth` n'a plus
 * d'équivalent (le visage bloub n'a pas de bouche) et reste accepté en
 * lecture ; un identifiant de l'ancien catalogue retombe sur un choix dérivé
 * de la graine, stable, plutôt que sur un visage unique pour tous.
 */

// Le visage dérivé d'une graine (`defaultFaceFor`) est dans `@openedbot/contracts-api`,
// que le serveur lit aussi.
export { COLORS, SHAPES, EXPRESSIONS };
export type { BotColor, BotShape, BotExpression };

/** Le visage par défaut de l'éditeur : celui de la marque, au repos. */
export const DEFAULT_FACE: BotFaceSpec = {
  palette: DEFAULT_COLOR,
  shape: DEFAULT_SHAPE,
  eyes: DEFAULT_EXPRESSION,
};

/** Un visage au hasard, pour le dé de l'éditeur. */
export function randomFace(): BotFaceSpec {
  const any = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;
  return {
    palette: any(COLORS).id,
    shape: any(SHAPES).id,
    eyes: any(EXPRESSIONS).id,
  };
}

export type ResolvedFace = {
  color: BotColor;
  shape: BotShape;
  expression: BotExpression;
};

/**
 * Résout une spécification en préréglages bloub.
 *
 * Un identifiant inconnu (un préréglage retiré, ou un visage de l'ancien
 * catalogue à quatre axes) retombe sur un choix dérivé de la graine plutôt
 * que de faire disparaître le visage : une pastille vide dans la liste serait
 * un bug bien plus visible que la mauvaise forme.
 */
export function resolveFace(spec: BotFaceSpec, seed = ""): ResolvedFace {
  const find = <T extends { id: string }>(list: readonly T[], id: string, salt: string) =>
    list.find((entry) => entry.id === id) ?? pickBySeed(list, seed, salt);
  return {
    color: find(COLORS, spec.palette, "palette"),
    shape: find(SHAPES, spec.shape, "shape"),
    expression: find(EXPRESSIONS, spec.eyes, "eyes"),
  };
}
