/**
 * Apprentissage d'un bot : la réponse amont à « apprends X » n'est pas une
 * ligne de mémoire, c'est un SKILL.
 *
 * Chez hermes-agent, un savoir procédural ou thématique va dans
 * `~/.hermes/skills/<name>/SKILL.md` via l'outil `skill_manage`
 * (`tools/skill_manager_tool.py`), la mémoire n'étant que « l'exception
 * étroite » des faits valables dans toutes les sessions
 * (`agent/prompt_builder.py`, `MEMORY_GUIDANCE` : « Skills come first »). La
 * commande `/learn <sujet|URL>` (`agent/learn_prompt.py`, `build_learn_prompt`)
 * ne fait rien d'autre que réécrire le tour en consigne : rassembler les
 * sources avec les outils, puis écrire le skill aux standards maison.
 *
 * openedbot reprend exactement ce partage : les faits sur l'opérateur passent par
 * `remember:` (`bot-memory.ts`, gouvernés et effaçables depuis l'app) ; le
 * savoir-faire passe par les skills du runtime, lues par `GET /v1/skills` et
 * montrées dans le panneau Capacités. Le toolset `skills` n'est pas dans
 * `ALWAYS_FORBIDDEN_TOOLSETS` : ce module ne s'active que si l'hôte l'annonce actif.
 *
 * Mesuré le 03-09 (gpt-5.6-luna, effort low, VPS avec `web` actif et `skills`
 * coupé) : à « apprend le framework symfony », le bot répond « Compris… » et
 * écrit une ligne `remember:`. Aucun appel d'outil. Sans consigne, un modèle
 * lit « apprends » comme « retiens » ; ce bloc nomme ce faux ami.
 */

/** Le toolset amont qui porte `skills_list`, `skill_view`, `skill_manage`. */
export const LEARNING_TOOLSET = "skills";

export type ToolsetPresence = { name: string; enabled: boolean };

/** L'hôte a-t-il annoncé le toolset `skills` ACTIF ? Jamais supposé d'une version. */
export function runtimeCanLearn(toolsets: readonly ToolsetPresence[] | null | undefined): boolean {
  return toolsets?.some((toolset) => toolset.name === LEARNING_TOOLSET && toolset.enabled) ?? false;
}

/**
 * Une demande d'ACQUISITION de compétence, pas de mémorisation d'un fait.
 * « apprends-moi X » (enseigne-moi) n'en est pas une : c'est une question.
 */
const LEARN_REQUEST = new RegExp(
  "^\\s*(?:/learn\\b|(?:apprends?|apprenez|étudie|etudie|étudiez|etudiez|maîtrise|maitrise|maîtrisez|maitrisez|"
  + "deviens|devenez|assimile|assimilez|learn|study|master|become)\\b(?!-(?:moi|nous)\\b)(?!\\s+(?:moi|nous|me|us)\\b))",
  "iu",
);

export function isLearnRequest(input: string): boolean {
  return LEARN_REQUEST.test(input);
}

/** Le sujet, débarrassé du verbe, pour nommer la consigne. */
function learnSubject(input: string): string {
  return input.replace(LEARN_REQUEST, "").replace(/^\s*(?:le|la|les|l'|the|a|an|du|de la|des)\s+/iu, "").trim();
}

/**
 * Le tour réécrit, à la façon de `build_learn_prompt` : la demande d'origine
 * reste citée, la consigne dit quoi faire des outils et quoi rendre. En
 * anglais comme le reste du cadrage système.
 */
export function buildLearnInput(input: string): string {
  const subject = learnSubject(input) || input.trim();
  return [
    `The user asked you to LEARN a competence: "${input.trim()}".`,
    "",
    "This is not a request to remember a fact. Acquire the competence now, inside this run, and make it durable as a skill:",
    "1. Gather sources with your tools: `web_search` then `web_extract` on the official documentation and one or two reference guides (or `read_file` / `search_files` for local material). Read enough to be precise, not exhaustive.",
    `2. Check \`skills_list\` first. If a skill already covers "${subject}", extend it with \`skill_manage\` (\`patch\` or \`write_file\` under \`references/\`); otherwise \`create\` a new one, named after the subject in kebab-case.`,
    "3. Write the SKILL.md for a senior practitioner: a one-line description (60 characters max), then the sections `When to Use`, `Prerequisites`, `Quick Reference`, `Procedure`, `Pitfalls`, `Verification`. Large sources become a knowledge-base skill: an index in SKILL.md plus one file per chapter under `references/`.",
    "4. Prove the write: call `skill_view` on the skill you wrote and confirm the content is there.",
    "5. Reply to the user with the skill name, what it now contains (sections and references), the sources you used, and what you could not cover. Never answer only \"understood\" or \"noted\": that would record nothing.",
    "",
    "Do all of this in this reply. There is no later turn to finish it in.",
  ].join("\n");
}

/**
 * Le bloc ajouté aux instructions quand le runtime annonce `skills` actif.
 * Il vit APRÈS le bloc bot-mode : c'est la liste que le modèle suit.
 */
export type LearningBlockOptions = {
  /** Le toolset `memory` est actif sur le profil cloisonné de ce bot. */
  memoryToolEnabled?: boolean;
};

export function buildLearningBlock(options: LearningBlockOptions = {}): string {
  const facts = options.memoryToolEnabled
    ? "Facts about the operator go through your runtime `memory` tool (they live on this profile). Procedures, frameworks, methods and domain knowledge go in a skill, never the other way round."
    : "Memory is off on this profile, so nothing you learn about the operator persists; procedures, frameworks, methods and domain knowledge still go in a skill.";
  return [
    "## Learning",
    "",
    "Your durable know-how lives in SKILLS on your runtime (`skills_list`, `skill_view`, `skill_manage`). The operator sees them in this app, under your capabilities. " + facts,
    "",
    "Rules:",
    "- Before replying, scan your skills. If one matches the task, load it with `skill_view` and follow it.",
    "- When the user asks you to learn, study, master or become expert at something, in any language, do NOT just acknowledge. Research it with your tools, then write or extend a skill with `skill_manage`, verify it with `skill_view`, and report what the skill now contains. Replying \"understood\" records nothing.",
    "- When a skill you loaded was missing steps or was wrong, patch it before finishing.",
    "- After a difficult or iterative task, offer to save the procedure as a skill.",
    ...(options.memoryToolEnabled
      ? ["- Durable facts (preferences, decisions, constraints, names) belong in the runtime `memory` tool; if the call fails, say so plainly rather than claiming the fact is kept. Do not put procedures there."]
      : []),
  ].join("\n");
}
