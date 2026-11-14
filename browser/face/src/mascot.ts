import { COLORS } from "@openedbot/contracts-api";
import type { BotFaceSpec } from "@openedbot/contracts-api";

/**
 * The cat face: the official openedbot mascot
 * (`apps/console/public/brand/openedbot-bloub.svg`), its silhouette as is,
 * recoloured per bot, with eyes and one small sign of the bot's job drawn in
 * the same flat style. The same drawing as the landing (`openedbot-site`,
 * `src/lib/mascot.ts`): a bot suggested on the home must look like its tile
 * on openedbot.app.
 *
 * In `BotFaceSpec` a cat is `shape: "chat"`: `palette` carries its colour,
 * `eyes` its eye style and `accessory` its sign. "chat" is deliberately NOT
 * in the bloub `SHAPES`: that list's order feeds `defaultFaceFor`, and
 * growing it would change the head of every bot that chose nothing.
 * Coordinates are the mascot's own 1024 artboard.
 */

export const MASCOT_SHAPE = "chat";

export const MASCOT_EYE_STYLES = ["pill", "round", "happy", "square"] as const;
export type MascotEyeStyle = (typeof MASCOT_EYE_STYLES)[number];

export const MASCOT_ACCESSORIES = ["antenna", "glasses", "waves", "sprout", "headset", "gear"] as const;
export type MascotAccessory = (typeof MASCOT_ACCESSORIES)[number];

/**
 * The cat's colours: the bloub palette, plus the slate of Méca on the
 * landing, which no bloub colour matches.
 */
export const MASCOT_EXTRA_COLORS = [{ id: "ardoise", hex: "#6b7a8f" }] as const;
const MASCOT_HEX = new Map<string, string>([
  ...COLORS.map((color) => [color.id, color.hex] as [string, string]),
  ...MASCOT_EXTRA_COLORS.map((color) => [color.id, color.hex] as [string, string]),
]);

export type ResolvedMascot = {
  /** The palette id, or `null` when it was unknown and the default stood in. */
  colorId: string | null;
  color: string;
  eyes: MascotEyeStyle;
  /** `null`: the bare mascot, no sign. */
  accessory: MascotAccessory | null;
};

/** The mascot's own orange, the brand cat. */
const DEFAULT_MASCOT_COLOR = "orange";

export function isMascotFace(face: BotFaceSpec | null | undefined): boolean {
  return face?.shape === MASCOT_SHAPE && !face.artwork;
}

/**
 * Reads a cat face. An unknown value (a future accessory read by an older
 * client) falls back to the plain mascot rather than to an empty chip.
 */
export function resolveMascot(face: BotFaceSpec): ResolvedMascot {
  const hex = MASCOT_HEX.get(face.palette);
  const eyes = (MASCOT_EYE_STYLES as readonly string[]).includes(face.eyes) ? (face.eyes as MascotEyeStyle) : "pill";
  const accessory = typeof face.accessory === "string" && (MASCOT_ACCESSORIES as readonly string[]).includes(face.accessory)
    ? (face.accessory as MascotAccessory)
    : null;
  return {
    colorId: hex ? face.palette : null,
    color: hex ?? MASCOT_HEX.get(DEFAULT_MASCOT_COLOR)!,
    eyes,
    accessory,
  };
}

export function mascotFace(palette: string, eyes: MascotEyeStyle, accessory: MascotAccessory | null): BotFaceSpec {
  return accessory ? { shape: MASCOT_SHAPE, palette, eyes, accessory } : { shape: MASCOT_SHAPE, palette, eyes };
}
