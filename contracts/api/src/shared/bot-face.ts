export type BotFaceSpec = {
  /** Couleur bloub (`bot-face.ts`, rendue par `@openedbot/browser-face`). Nom historique conservé. */
  palette: string;
  /** Forme bloub. */
  shape: string;
  /** Expression de repos bloub. Nom historique conservé. */
  eyes: string;
  /** Ancien catalogue à quatre axes : accepté en lecture, plus produit. */
  mouth?: string;
  artwork?: string;
};

/**
 * Le catalogue de visages d'un bot, côté contrat : les identifiants que
 * `BotFaceSpec` peut porter, et le visage dérivé d'une graine pour un bot qui
 * n'en a pas choisi. Le serveur (import Hermes) et le navigateur le lisent ;
 * le rendu (rayons des formes, poses des expressions) reste dans
 * `@openedbot/browser-face`, qui ordonne ses tables sur celles-ci.
 *
 * L'ORDRE des listes fait partie du contrat : `defaultFaceFor` tire dans
 * l'ordre, donc le déplacer changerait la tête de chaque bot sans visage.
 */

export type ColorId =
  | "encre"
  | "creme"
  | "brun"
  | "rouge"
  | "orange"
  | "ambre"
  | "vert"
  | "turquoise"
  | "bleu"
  | "violet"
  | "rose"
  | "gris";

export type ShapeId =
  | "cercle"
  | "galet"
  | "squircle"
  | "capsule"
  | "triangle"
  | "hexagone"
  | "nuage"
  | "goutte";

export type ExpressionId =
  | "neutre"
  | "attentif"
  | "surpris"
  | "excite"
  | "heureux"
  | "hilare"
  | "colere"
  | "triste"
  | "effraye"
  | "mefiant"
  | "confus"
  | "curieux"
  | "fier"
  | "timide"
  | "blase"
  | "somnolent";

export type BotColor = { id: ColorId; hex: string };

/** Palette du personnalisateur d'origine. */
export const COLORS: readonly BotColor[] = [
  { id: "encre", hex: "#0a0a0c" },
  { id: "brun", hex: "#8b5e3c" },
  { id: "rouge", hex: "#e8483f" },
  { id: "orange", hex: "#f08a24" },
  { id: "ambre", hex: "#f0b429" },
  { id: "vert", hex: "#3ecf8e" },
  { id: "turquoise", hex: "#2fbfa0" },
  { id: "bleu", hex: "#3b93f0" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "rose", hex: "#e152b0" },
  { id: "gris", hex: "#a3a3a3" },
  { id: "creme", hex: "#f1efe9" },
];

/** Les formes proposées, par identifiant. Les rayons sont du rendu navigateur. */
export const SHAPES: readonly { id: ShapeId }[] = [
  { id: "cercle" },
  { id: "galet" },
  { id: "squircle" },
  { id: "capsule" },
  { id: "triangle" },
  { id: "hexagone" },
  { id: "nuage" },
  { id: "goutte" },
];

/** Les expressions de repos, par identifiant. Les poses sont du rendu navigateur. */
export const EXPRESSIONS: readonly { id: ExpressionId }[] = [
  { id: "neutre" },
  { id: "attentif" },
  { id: "surpris" },
  { id: "excite" },
  { id: "heureux" },
  { id: "hilare" },
  { id: "colere" },
  { id: "triste" },
  { id: "effraye" },
  { id: "mefiant" },
  { id: "confus" },
  { id: "curieux" },
  { id: "fier" },
  { id: "timide" },
  { id: "blase" },
  { id: "somnolent" },
];

/**
 * Hachage déterministe, salé par axe.
 *
 * Salé, parce que sans ça les trois axes tirent le même nombre : deux bots
 * qui tombent sur la même couleur tomberaient aussi sur la même forme et la
 * même expression, soit 12 visages possibles au lieu de 1 536.
 */
export function pickBySeed<T>(list: readonly T[], seed: string, salt: string): T {
  const key = `${salt}:${seed}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) >>> 0;
  }
  return list[hash % list.length]!;
}

/**
 * Le visage d'un bot qui n'en a pas choisi.
 *
 * Tiré de l'identifiant, donc stable : un bot ne change pas de tête entre deux
 * lancements, ni au renommage.
 */
export function defaultFaceFor(seed: string): BotFaceSpec {
  return {
    palette: pickBySeed(COLORS, seed, "palette").id,
    shape: pickBySeed(SHAPES, seed, "shape").id,
    eyes: pickBySeed(EXPRESSIONS, seed, "eyes").id,
  };
}
