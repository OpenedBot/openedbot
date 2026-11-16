import { describe, expect, test } from "bun:test";
import {
  ROUTINE_INTENT_REFUSAL,
  assistantProposedRoutineChange,
  hasRoutineCue,
  isShortAffirmative,
  routineChangeIntent,
  stripToolNotes,
} from "../src/domain/routine-intent";

const PROPOSAL = "Je peux créer une routine qui t'envoie les news IA chaque matin à 8h. Tu veux que je la crée ?";
const decide = (message: string, previousAssistant: string | null = null) =>
  routineChangeIntent({ message, previousAssistant });

describe("routine change intent (2026-11-16)", () => {
  test.each([
    "re",
    "Re",
    "hey",
    "Hey",
    "Hello guy !è",
    "ça va ti ?",
    "salut",
    "merci",
    "bonjour, tu vas bien ?",
    "thanks!",
    "What's the capital of France?",
    "Explique-moi les transformers",
    "",
  ])("%p does not ask for a routine change", (message) => {
    expect(decide(message)).toEqual({ allowed: false, reason: "none" });
    // An earlier proposal does not make a greeting an agreement.
    expect(decide(message, PROPOSAL).allowed).toBe(false);
  });

  test.each([
    "Ok créer toi une routine pour que tt les matin à 8h j'ai les news AI",
    "supprime là",
    "Supprime la routine des news",
    "rappelle-moi demain à 9h d'appeler Paul",
    "Rappelle moi dans 10 minutes",
    "tous les lundis, fais-moi un point sur le marché",
    "chaque soir envoie-moi un résumé",
    "programme un point hebdo",
    "planifie ça pour 18:30",
    "désactive la routine",
    "mets-la en pause",
    "remind me tomorrow at 9am",
    "every morning send me the AI news",
    "Create a daily routine for the weather",
    "schedule it weekly",
    "delete it",
    "pause the reminder",
    "turn it off",
    "resume it",
  ])("%p asks for a routine change", (message) => {
    expect(decide(message)).toEqual({ allowed: true, reason: "routine_cue" });
  });

  test.each(["oui", "Oui !", "ok", "OK vas-y", "yes please", "d'accord", "go", "oui merci", "vas y", "ok fais-le", "Yes, do it"])(
    "%p after a proposal agrees to it",
    (message) => {
      expect(decide(message, PROPOSAL)).toEqual({ allowed: true, reason: "affirmative_after_proposal" });
    },
  );

  test.each(["oui", "ok", "yes"])("%p without a proposal authorises nothing", (message) => {
    expect(decide(message)).toEqual({ allowed: false, reason: "none" });
    expect(decide(message, "Voici la réponse à ta question sur Python.").allowed).toBe(false);
    // A scheduling statement that asks nothing is no proposal.
    expect(decide(message, "Je ne peux pas programmer de routine ici.").allowed).toBe(false);
  });

  test("a negative or long reply is no agreement", () => {
    for (const message of ["non", "non merci", "ok mais pas maintenant", "oui je pense que la météo est bonne aujourd'hui en Bretagne"]) {
      expect(isShortAffirmative(message)).toBe(false);
    }
    expect(isShortAffirmative("oui")).toBe(true);
  });

  test("a proposal speaks of scheduling and asks", () => {
    expect(assistantProposedRoutineChange(PROPOSAL)).toBe(true);
    expect(assistantProposedRoutineChange("@kevin Je crée le rappel ?\n- Oui\n- Non")).toBe(true);
    expect(assistantProposedRoutineChange("Tu veux autre chose ?")).toBe(false);
    expect(assistantProposedRoutineChange(null)).toBe(false);
  });

  test("the tool notes earlier workers appended never count as a cue", () => {
    const stored = "re\n\n[routine_manage run_key: 92090000-0000-4000-8000-000000000101.abc]\n[routine_manage user timezone: Europe/Paris]\n[bot_settings_propose run_key: x.y]";
    expect(hasRoutineCue(stored)).toBe(true);
    expect(stripToolNotes(stored)).toBe("re");
    expect(decide(stripToolNotes(stored)).allowed).toBe(false);
  });

  test("the refusal tells the model what to do instead", () => {
    expect(ROUTINE_INTENT_REFUSAL).toContain("does not ask for a routine change");
    expect(ROUTINE_INTENT_REFUSAL).toContain("answer the user instead");
  });
});
