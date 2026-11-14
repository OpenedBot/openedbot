export type BotFaceSpec = {
  /** bloub color (`bot-face.ts`, rendered by `@openedbot/browser-face`). Historical name kept. */
  palette: string;
  /** bloub shape. */
  shape: string;
  /** bloub resting expression. Historical name kept. */
  eyes: string;
  /** Old four-axis catalog: accepted on read, no longer produced. */
  mouth?: string;
  artwork?: string;
  /**
   * The job sign of a cat face (`shape: "chat"`, `@openedbot/browser-face/mascot`):
   * `antenna`, `glasses`, `waves`, `sprout`, `headset` or `gear`. Absent: the bare mascot.
   */
  accessory?: string;
};

/**
 * A bot's face catalog, on the contract side: the identifiers
 * `BotFaceSpec` may carry, and the face derived from a seed for a bot that
 * has not chosen one. The server (Hermes import) and the browser read it;
 * the rendering (shape radii, expression poses) stays in
 * `@openedbot/browser-face`, which orders its tables on these.
 *
 * The ORDER of the lists is part of the contract: `defaultFaceFor` draws in
 * order, so moving it would change the head of every bot without a face.
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

/** Palette of the original customizer. */
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

/** The shapes offered, by identifier. The radii belong to the browser rendering. */
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

/** The resting expressions, by identifier. The poses belong to the browser rendering. */
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
 * Deterministic hash, salted per axis.
 *
 * Salted, because without that the three axes draw the same number: two bots
 * that land on the same color would also land on the same shape and the
 * same expression, that is 12 possible faces instead of 1 536.
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
 * The face of a bot that has not chosen one.
 *
 * Drawn from the identifier, so stable: a bot does not change head between two
 * launches, nor on rename.
 */
export function defaultFaceFor(seed: string): BotFaceSpec {
  return {
    palette: pickBySeed(COLORS, seed, "palette").id,
    shape: pickBySeed(SHAPES, seed, "shape").id,
    eyes: pickBySeed(EXPRESSIONS, seed, "eyes").id,
  };
}
