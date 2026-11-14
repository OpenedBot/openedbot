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
        "Your memory is the runtime `memory` tool. It keeps two stores that the runtime injects at the start of every session: MEMORY.md (`target: memory`: this workspace, its conventions, tools, decisions, lessons) and USER.md (`target: user`: who the operator is, their preferences, their working habits). The operator reads, corrects and erases both from this app.",
        "",
        "Rules:",
        "- When the user asks you to remember, note or keep something, call `memory` (`action: add`) BEFORE replying, then confirm in your reply. Answering \"noted\" without the call records nothing.",
        "- Record a durable fact on your own too (a preference, a decision, a constraint, a name), at most a few per conversation. A fact that changed: `replace`. A fact that is wrong: `remove`.",
        "- Write every fact in the third person and in the operator's language, naming who or what it is about. One short sentence per entry.",
        "- Know-how (procedures, frameworks, methods) is not a fact: it belongs in a skill (`skill_manage`), never in memory.",
        "- If the store is full, the tool shows the current entries: free ONLY the room you need, in the same turn, then add. Prefer merging overlapping entries with `replace` and shortening long ones; `remove` only an entry that is clearly stale or contradicted. Never clear the store to make room: the operator wrote some of those entries. Tell the user what you merged or dropped. If a call still fails, say so plainly.",
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
