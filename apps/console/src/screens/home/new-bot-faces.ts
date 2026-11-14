import { COLORS, type BotFaceSpec, type ColorId, type CreateRoutineInput, type ExpressionId, type ShapeId } from "@openedbot/contracts-api";
import {
  MASCOT_EXTRA_COLORS,
  MASCOT_SHAPE,
  mascotFace,
  type MascotAccessory,
  type MascotEyeStyle,
} from "@openedbot/browser-face/mascot";

/**
 * The face chosen on the `/` home: one of the presets, tinted with the
 * chosen colour, or with its own in « auto ». ONE cat first (the openedbot
 * mascot, as on openedbot.app), then the eight bloub shapes of the full
 * editor (`FaceFields`), in one click, like the reference app's home. The cat's eyes
 * and job sign come from the suggestion that filled the form (`cat`).
 */
type CatPreset = { shape: typeof MASCOT_SHAPE; color: string };
type BloubPreset = { shape: ShapeId; eyes: ExpressionId; color: ColorId };
export type HomeFacePreset = CatPreset | BloubPreset;

/** The cat's index in `HOME_FACE_PRESETS`. */
export const CAT_PRESET = 0;

export const HOME_FACE_PRESETS: readonly HomeFacePreset[] = [
  { shape: MASCOT_SHAPE, color: "orange" },
  { shape: "squircle", eyes: "neutre", color: "turquoise" },
  { shape: "triangle", eyes: "mefiant", color: "ambre" },
  { shape: "galet", eyes: "blase", color: "vert" },
  { shape: "cercle", eyes: "curieux", color: "violet" },
  { shape: "hexagone", eyes: "surpris", color: "rose" },
  { shape: "nuage", eyes: "timide", color: "rouge" },
  { shape: "capsule", eyes: "attentif", color: "orange" },
  { shape: "goutte", eyes: "fier", color: "bleu" },
];

/** The tints offered after « auto », in chromatic-circle order. */
export const HOME_FACE_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;
export type HomeFaceColor = (typeof HOME_FACE_COLORS)[number];

/** Every colour a preset may carry, cats' slate included. */
export const HOME_FACE_HEX: ReadonlyMap<string, string> = new Map([
  ...COLORS.map((color) => [color.id, color.hex] as [string, string]),
  ...MASCOT_EXTRA_COLORS.map((color) => [color.id, color.hex] as [string, string]),
]);

/** The look a suggestion gives the cat: its eyes, its job sign, its colour. */
export type CatLook = { eyes: MascotEyeStyle; accessory: MascotAccessory | null; color: string };

/**
 * `auto`: each preset keeps its colour. `cat`: the look of the suggestion
 * that filled the form, worn by the cat preset only (and kept while the
 * operator tries a bloub, so coming back to the cat finds it again).
 */
export type HomeFaceChoice = { preset: number; color: HomeFaceColor | "auto"; cat?: CatLook };

export function homeFace(choice: HomeFaceChoice, preset = choice.preset): BotFaceSpec {
  const entry = HOME_FACE_PRESETS[preset] ?? HOME_FACE_PRESETS[CAT_PRESET]!;
  if (entry.shape === MASCOT_SHAPE) {
    const look = choice.cat;
    const palette = choice.color === "auto" ? (look?.color ?? entry.color) : choice.color;
    return mascotFace(palette, look?.eyes ?? "pill", look?.accessory ?? null);
  }
  const bloub = entry as BloubPreset;
  return { shape: bloub.shape, eyes: bloub.eyes, palette: choice.color === "auto" ? bloub.color : choice.color };
}

/** A fresh form starts on the cat: the brand face is the default. */
export function defaultHomeFaceChoice(): HomeFaceChoice {
  return { preset: CAT_PRESET, color: "auto" };
}

/** The routine a suggestion programs with its bot: 5-field cron, in the operator's timezone. */
type SuggestionRoutine = { key: "rafale" | "sillage"; schedule: string };

/**
 * The suggestions under the form: the cast of openedbot.app, each a whole
 * bot (name, cat face, role, mission, working rules) and, when the job has a
 * rhythm, its routine. Names do not translate, as on the landing.
 */
export const HOME_SUGGESTIONS = [
  { id: "rafale", name: "Rafale", look: { color: "orange", eyes: "pill", accessory: "antenna" }, routine: { key: "rafale", schedule: "0 17 * * 5" } },
  { id: "brume", name: "Brume", look: { color: "violet", eyes: "pill", accessory: "glasses" }, routine: null },
  { id: "sillage", name: "Sillage", look: { color: "turquoise", eyes: "pill", accessory: "waves" }, routine: { key: "sillage", schedule: "0 8 * * 1-5" } },
  { id: "aurore", name: "Aurore", look: { color: "vert", eyes: "happy", accessory: "sprout" }, routine: null },
  { id: "corail", name: "Corail", look: { color: "rouge", eyes: "round", accessory: "headset" }, routine: null },
  { id: "meca", name: "Méca", look: { color: "ardoise", eyes: "square", accessory: "gear" }, routine: null },
] as const satisfies readonly { id: string; name: string; look: CatLook; routine: SuggestionRoutine | null }[];

export type HomeSuggestion = (typeof HOME_SUGGESTIONS)[number];
export type HomeSuggestionId = HomeSuggestion["id"];

/** The form's face once a suggestion filled it: the cat, in the suggestion's look. */
export function suggestionFaceChoice(suggestion: HomeSuggestion): HomeFaceChoice {
  return { preset: CAT_PRESET, color: "auto", cat: suggestion.look };
}

/** The operator's IANA timezone, `UTC` when the browser does not say. */
export function operatorTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function suggestionRoutine(
  routine: SuggestionRoutine,
  text: { name: string; message: string },
  timezone: string,
): CreateRoutineInput {
  return { name: text.name, message: text.message, schedule: routine.schedule, timezone, enabled: true };
}
