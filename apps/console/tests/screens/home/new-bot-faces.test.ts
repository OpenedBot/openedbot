import { describe, expect, test } from "bun:test";
import { SHAPES } from "@openedbot/contracts-api";
import { MASCOT_SHAPE } from "@openedbot/browser-face/mascot";
import { en } from "@openedbot/browser-i18n/messages.en";
import { fr } from "@openedbot/browser-i18n/messages.fr";
import {
  CAT_PRESET,
  HOME_FACE_PRESETS,
  HOME_SUGGESTIONS,
  defaultHomeFaceChoice,
  homeFace,
  suggestionFaceChoice,
  suggestionRoutine,
} from "../../../src/screens/home/new-bot-faces";

describe("home faces", () => {
  test("one cat, then every bloub shape once", () => {
    expect(HOME_FACE_PRESETS.filter((preset) => preset.shape === MASCOT_SHAPE)).toHaveLength(1);
    expect(HOME_FACE_PRESETS[CAT_PRESET]!.shape).toBe(MASCOT_SHAPE);
    const bloubs = HOME_FACE_PRESETS.filter((preset) => preset.shape !== MASCOT_SHAPE).map((preset) => preset.shape);
    expect([...bloubs].sort()).toEqual(SHAPES.map((shape) => shape.id).sort());
  });

  test("a fresh form starts on the plain orange cat", () => {
    expect(homeFace(defaultHomeFaceChoice())).toEqual({ shape: MASCOT_SHAPE, palette: "orange", eyes: "pill" });
  });

  test("a colour picked by hand tints the cat and keeps the suggestion's look", () => {
    const rafale = HOME_SUGGESTIONS[0];
    expect(homeFace({ ...suggestionFaceChoice(rafale), color: "bleu" })).toEqual({ shape: MASCOT_SHAPE, palette: "bleu", eyes: "pill", accessory: "antenna" });
  });

  test("trying a bloub shape after a suggestion gives a plain bloub face", () => {
    const face = homeFace(suggestionFaceChoice(HOME_SUGGESTIONS[1]), 1);
    expect(face.shape).not.toBe(MASCOT_SHAPE);
    expect(face.accessory).toBeUndefined();
  });
});

describe("home suggestions: the cast of openedbot.app", () => {
  test("each one wears its landing cat", () => {
    const faces = Object.fromEntries(HOME_SUGGESTIONS.map((suggestion) => [suggestion.name, homeFace(suggestionFaceChoice(suggestion))]));
    expect(faces.Rafale).toEqual({ shape: MASCOT_SHAPE, palette: "orange", eyes: "pill", accessory: "antenna" });
    expect(faces.Brume).toEqual({ shape: MASCOT_SHAPE, palette: "violet", eyes: "pill", accessory: "glasses" });
    expect(faces.Sillage).toEqual({ shape: MASCOT_SHAPE, palette: "turquoise", eyes: "pill", accessory: "waves" });
    expect(faces.Aurore).toEqual({ shape: MASCOT_SHAPE, palette: "vert", eyes: "happy", accessory: "sprout" });
    expect(faces.Corail).toEqual({ shape: MASCOT_SHAPE, palette: "rouge", eyes: "round", accessory: "headset" });
    expect(faces["Méca"]).toEqual({ shape: MASCOT_SHAPE, palette: "ardoise", eyes: "square", accessory: "gear" });
  });

  test("every suggestion has its role, hint, mission and rules in both languages", () => {
    for (const { homeNewBot } of [fr, en]) {
      for (const suggestion of HOME_SUGGESTIONS) {
        const text = homeNewBot.suggestion[suggestion.id];
        for (const field of [text.role, text.hint, text.mission, text.rules]) expect(field.trim().length).toBeGreaterThan(0);
        if (suggestion.routine) {
          const routine = homeNewBot.routines[suggestion.routine.key];
          expect(routine.name && routine.when && routine.message).toBeTruthy();
        }
      }
    }
  });

  test("Rafale reports on Friday at 5 pm, Sillage watches on weekday mornings, the others have no routine", () => {
    const schedules = Object.fromEntries(HOME_SUGGESTIONS.map((suggestion) => [suggestion.id, suggestion.routine?.schedule ?? null]));
    expect(schedules).toEqual({ rafale: "0 17 * * 5", brume: null, sillage: "0 8 * * 1-5", aurore: null, corail: null, meca: null });
  });

  test("the routine is created enabled, in the operator's timezone", () => {
    const routine = suggestionRoutine(HOME_SUGGESTIONS[0].routine!, { name: "Point du vendredi", message: "Le point." }, "Europe/Paris");
    expect(routine).toEqual({ name: "Point du vendredi", message: "Le point.", schedule: "0 17 * * 5", timezone: "Europe/Paris", enabled: true });
  });
});
