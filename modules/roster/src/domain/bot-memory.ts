/**
 * La mémoire d'un bot : celle du RUNTIME, et elle seule.
 *
 * Un bot à profil géré tient `MEMORY.md` (projet) et `USER.md` (opérateur)
 * dans son profil Hermes ; le runtime les injecte au début de chaque session
 * et le bot les écrit avec son outil `memory`. openedbot ne garde aucun fait en
 * base : l'écran Mémoire lit et corrige ce magasin par le lien
 * (`GET`/`POST /hermes-setup/profiles/{slug}/memory`).
 *
 * Ce module ne porte plus que le bloc d'instructions qui dit au bot si son
 * outil existe dans la session. L'ancien régime openedbot (`bot_memories`, lignes
 * `remember:`, approbation, extraction automatique) a été retiré le 07-09 :
 * tout vient de Hermes.
 */

/** Plafonds par défaut du magasin amont (`memory_char_limit`, `user_char_limit`). */
export const RUNTIME_MEMORY_DEFAULT_LIMITS = { memory: 2_200, user: 1_375 } as const;

export type RuntimeMemoryBlockOptions = {
  /** Le toolset `memory` est actif sur le profil : l'outil existe dans la session. */
  toolEnabled: boolean;
};

/**
 * Le bloc mémoire d'un bot à PROFIL GÉRÉ : sa mémoire est celle du runtime
 * (`MEMORY.md` / `USER.md` du profil, injectés par Hermes lui-même au début
 * de la session, écrits par l'outil `memory`). openedbot n'injecte aucun fait et
 * n'accepte aucune ligne `remember:` : ce qu'un tel bot retient se lit et
 * se corrige dans l'écran Mémoire, qui relit le magasin du profil.
 *
 * Deux états, et le bot doit savoir lequel : outil présent, ou mémoire
 * coupée (toolset `memory` inactif). Mesuré le 07-09 : sans le dire, le bot
 * cherchait MEMORY.md par `execute_code` puis répondait « je ne peux pas ».
 */
export function buildRuntimeMemoryBlock(options: RuntimeMemoryBlockOptions): string {
  const rules = options.toolEnabled
    ? [
        "Runtime `memory` persists MEMORY.md (`target: memory`: workspace, conventions, tools, decisions, lessons) and USER.md (`target: user`: operator, preferences, habits), injected each session. The operator can read, correct and erase both in this app.",
        "",
        "Rules:",
        "- When asked to remember, note or keep a fact, call `memory` (`action: add`) BEFORE replying; \"noted\" alone saves nothing.",
        "- Also save a few durable facts per conversation (preferences, decisions, constraints, names). Use `replace` for changed facts, `remove` for wrong ones. Write one short sentence per entry, third person, operator's language, naming its subject.",
        "- Procedures, frameworks and methods belong in skills, never memory.",
        "- If full, merge/shorten entries with `replace`; `remove` only clearly stale or contradicted entries. Free only the space needed, then add in this turn. Never clear the store: some entries are the operator's. Report merges/removals and any failed call.",
        "- Never write `remember:` or `forget:` lines, and never use `terminal`, `execute_code` or file tools to look for or edit MEMORY.md / USER.md.",
      ]
    : [
        "Memory is switched off on this profile: the `memory` tool is not available and nothing you learn persists beyond this conversation.",
        "",
        "Rules:",
        "- If the user asks you to remember something, say plainly that memory is off and that the operator can switch it on in your settings, under Memory. Do not pretend to record it.",
        "- Never write `remember:` or `forget:` lines, and never use `terminal`, `execute_code` or file tools to look for or edit MEMORY.md / USER.md.",
      ];
  return ["## Memory", "", ...rules].join("\n");
}
