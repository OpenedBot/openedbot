import type { BotFaceSpec, ColorId, ExpressionId, ShapeId } from "@openedbot/contracts-api";

/**
 * Le visage choisi sur l'accueil `/` : un des douze préréglages (forme et
 * expression), teint de la couleur choisie, ou de la sienne en « auto ».
 * Les mêmes visages bloub que l'éditeur complet (`FaceFields`), réduits à
 * deux rangées d'un clic, comme l'accueil d'OpenBot.
 */
export type HomeFacePreset = { shape: ShapeId; eyes: ExpressionId; color: ColorId };

export const HOME_FACE_PRESETS: readonly HomeFacePreset[] = [
  { shape: "squircle", eyes: "neutre", color: "turquoise" },
  { shape: "triangle", eyes: "mefiant", color: "ambre" },
  { shape: "galet", eyes: "blase", color: "vert" },
  { shape: "cercle", eyes: "curieux", color: "violet" },
  { shape: "hexagone", eyes: "surpris", color: "rose" },
  { shape: "nuage", eyes: "timide", color: "rouge" },
  { shape: "capsule", eyes: "attentif", color: "orange" },
  { shape: "triangle", eyes: "heureux", color: "ambre" },
  { shape: "squircle", eyes: "excite", color: "turquoise" },
  { shape: "capsule", eyes: "somnolent", color: "orange" },
  { shape: "hexagone", eyes: "effraye", color: "bleu" },
  { shape: "goutte", eyes: "fier", color: "vert" },
];

/** Les teintes proposées après « auto », dans l'ordre du cercle chromatique. */
export const HOME_FACE_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;
export type HomeFaceColor = (typeof HOME_FACE_COLORS)[number];

/** `auto` : chaque préréglage garde sa couleur. */
export type HomeFaceChoice = { preset: number; color: HomeFaceColor | "auto" };

export function homeFace(choice: HomeFaceChoice, preset = choice.preset): BotFaceSpec {
  const entry = HOME_FACE_PRESETS[preset] ?? HOME_FACE_PRESETS[0]!;
  return { shape: entry.shape, eyes: entry.eyes, palette: choice.color === "auto" ? entry.color : choice.color };
}

export function randomHomeFaceChoice(): HomeFaceChoice {
  return { preset: Math.floor(Math.random() * HOME_FACE_PRESETS.length), color: "auto" };
}

/** Les suggestions sous le formulaire : un nom, une mission, un visage. */
export const HOME_SUGGESTIONS = [
  { id: "writer", face: { preset: 6, color: "ambre" } },
  { id: "research", face: { preset: 3, color: "bleu" } },
  { id: "support", face: { preset: 5, color: "vert" } },
  { id: "mail", face: { preset: 1, color: "rose" } },
  { id: "watch", face: { preset: 4, color: "violet" } },
  { id: "data", face: { preset: 0, color: "turquoise" } },
] as const satisfies readonly { id: string; face: HomeFaceChoice }[];
