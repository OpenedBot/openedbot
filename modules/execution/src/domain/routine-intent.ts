/**
 * Whether the user's CURRENT message authorises a routine change through
 * `routine_manage` (create, update, pause, resume, remove).
 *
 * Measured in production on 2026-11-16: a bot answered « re » with
 * tool_search → tool_describe → routine_manage create, recreating a routine
 * from an old request still visible in its history. The prompt rules alone
 * did not hold, so the API checks the message that started the run before it
 * writes anything: the model may still decide NOT to call the tool, but it can
 * no longer change routines on a turn whose message says nothing about them.
 *
 * The check is deliberately generous (French and English cues, abbreviations,
 * no accents): it only has to tell « re », « hey », « ça va ti ? » apart from a
 * scheduling or routine-management request. A false « yes » lets the model's
 * own judgement decide, as before; a false « no » returns an error the model
 * reads and explains, and the user can still use « Routines… ».
 *
 * Pure: no database, no clock.
 */

export type RoutineIntentReason = "routine_cue" | "affirmative_after_proposal" | "none";

export type RoutineIntentDecision = {
  allowed: boolean;
  reason: RoutineIntentReason;
};

/** The tool error the model reads when the current message does not ask for a routine change. */
export const ROUTINE_INTENT_REFUSAL =
  "The current user message does not ask for a routine change. Do not create, modify or delete routines based on earlier history; answer the user instead.";

/** Lowercase, accents and apostrophe variants removed, punctuation turned into spaces. */
export function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^\p{L}\p{N}':]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Each pattern runs on `normalizeIntentText` output: no accents, single spaces.
const ROUTINE_CUES: readonly RegExp[] = [
  // Nouns and verbs that only make sense for scheduling.
  /\broutines?\b/,
  /\brappel(s|le|les|lez|ler|er)?\b/,
  /\brappelle[rz]?\b/,
  /\bremind(er|ers|s)?\b/,
  /\balarm(e|es|s)?\b/,
  /\bcron\b/,
  /\b(re)?schedul(e|ed|es|ing)\b/,
  /\bplanifi(e|es|er|ez|cation)\b/,
  /\b(re)?programm(e|es|er|ez|ation)\b/,
  /\bautomatis(e|es|er|ez)\b/,
  /\bautomat(e|ically)\b/,
  // Recurrence.
  /\b(tous|toutes|tt|ts|tte|ttes) les\b/,
  /\bchaque (jour|matin|soir|nuit|semaine|mois|annee|heure|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|weekend|week end)\b/,
  /\b(every|each) (day|morning|evening|night|week|month|year|hour|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+)\b/,
  /\b(daily|weekly|monthly|hourly|yearly|weekdays|quotidien(ne)?s?|hebdo(madaire)?s?|mensuel(le)?s?)\b/,
  /\b(le|les) (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)s? (a|matin|soir)\b/,
  // A time of day or a moment in the future.
  /\b\d{1,2} ?h(\d{2})?\b/,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2} ?(am|pm)\b/,
  /\b(a|at) (midi|minuit|noon|midnight)\b/,
  /\b(demain|apres demain|tomorrow|tonight|ce soir)\b/,
  /\b(dans|in) \d+ ?(s|sec|secondes?|seconds?|m|mn|min|mins|minutes?|h|heures?|hours?|jours?|days?|semaines?|weeks?)\b/,
  // Managing an existing routine (the object is often only « la », « it »).
  /\b(supprim|efface|retir|enlev|annul|arret|stopp|suspend|modifi|decal|renomm)\w*/,
  /\b(des|re)?activ(e|es|er|ez)\b/,
  /\bmets? (la |le |les )?en pause\b/,
  /\b(reprends|reprendre|relance[rz]?)\b/,
  /\b(delete|remove|cancel|disable|enable|pause|resume|unpause|stop|rename|update|change|move|turn (it )?(off|on))\b/,
];

/** A routine or scheduling cue anywhere in the text. */
export function hasRoutineCue(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return ROUTINE_CUES.some((pattern) => pattern.test(normalized));
}

// A short reply made only of these words agrees with what was just proposed.
const AFFIRMATIVE_CORE = new Set([
  "oui", "ouais", "ouai", "ouep", "yes", "yep", "yeah", "yup", "ok", "okay", "oki", "okk", "dac", "d'accord", "daccord",
  "vas", "vas-y", "vasy", "go", "sure", "parfait", "top", "carrement", "absolument", "exactement", "confirme",
  "valide", "volontiers", "marche", "fais", "do", "agreed", "certainly", "bien", "please",
]);
const AFFIRMATIVE_FILLER = new Set([
  "y", "le", "la", "les", "it", "ca", "c'est", "cest", "bon", "sur", "stp", "svp", "merci", "thanks", "thank",
  "you", "let's", "lets", "on", "ah", "alors", "si", "tu", "veux", "peux", "je", "that", "this",
]);
const AFFIRMATIVE_MAX_WORDS = 6;

/** « oui », « ok vas-y », « yes please », « d'accord merci »: a short agreement and nothing else. */
export function isShortAffirmative(text: string): boolean {
  const words = normalizeIntentText(text.replace(/-/g, " ")).split(" ").filter(Boolean)
    .map((word) => word.replace(/^'+|'+$/g, ""));
  if (words.length === 0 || words.length > AFFIRMATIVE_MAX_WORDS) return false;
  const joined = words.join(" ");
  if (/\b(non|no|nope|pas|not|never|jamais|annule|cancel)\b/.test(joined)) return false;
  let core = false;
  for (const word of words) {
    if (AFFIRMATIVE_CORE.has(word)) core = true;
    else if (!AFFIRMATIVE_FILLER.has(word)) return false;
  }
  return core;
}

/**
 * Whether an assistant message proposed a routine change the user could agree
 * to: it speaks of scheduling and asks something.
 */
export function assistantProposedRoutineChange(text: string | null | undefined): boolean {
  if (!text) return false;
  return hasRoutineCue(text) && text.includes("?");
}

/**
 * The decision for one tool call. `message` is the user's text that started
 * the run (with any follow-ups folded or steered into it); `previousAssistant`
 * is the assistant message just before it in the thread, or null.
 */
export function routineChangeIntent(input: {
  message: string;
  previousAssistant: string | null;
}): RoutineIntentDecision {
  if (hasRoutineCue(input.message)) return { allowed: true, reason: "routine_cue" };
  if (isShortAffirmative(input.message) && assistantProposedRoutineChange(input.previousAssistant)) {
    return { allowed: true, reason: "affirmative_after_proposal" };
  }
  return { allowed: false, reason: "none" };
}

/**
 * The bracketed tool notes earlier workers appended to the user's text
 * (`[routine_manage run_key: …]`, `[bot_settings_propose run_key: …]`). They
 * name the tool, so they must never count as the user asking for it.
 */
const TOOL_NOTE_LINE = /^\[(?:routine_manage|bot_settings_propose)[^\]\n]*\]\s*$/gmu;

export function stripToolNotes(input: string): string {
  return input.replace(TOOL_NOTE_LINE, "").trim();
}
