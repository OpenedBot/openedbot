import { workflowSessionKey } from "./autonomous-workflow";
import { personaDraftSessionKey } from "./persona-draft";
import { greetingSessionKey } from "./bot-greeting-session";
import { compactionSessionKey } from "@openedbot/conversation/domain/thread-compaction";
import { threadSessionKeys } from "@openedbot/conversation/domain/thread-session";

/**
 * TOUTES les sessions qu'openedbot a pu ouvrir sur le runtime pour ce bot.
 *
 * Il y en a cinq familles, et quatre ne sont nommées nulle part dans
 * `threads` : les oublier laisserait sur le VPS du client exactement ce qu'il
 * croit avoir effacé : la mémoire extraite de son bot, ses brouillons de
 * persona, les résumés de compaction de ses fils.
 *
 * Chaque fabrique de clé vit dans le module qui la possède (conversation,
 * roster) et est la SEULE source :
 * dupliquer la forme ici garantirait une divergence silencieuse le jour où
 * l'une d'elles change.
 *
 * Dédoublonné : deux familles peuvent produire la même clé (elles ne le font
 * pas aujourd'hui), et un DELETE répété compterait deux succès pour une seule
 * session effacée.
 */
export function botRuntimeSessionIds(
  organizationId: string,
  botId: string,
  scope: {
    threads: ReadonlyArray<{ sessionId: string; threadId: string; sessionGeneration?: number | null }>;
    workflows: ReadonlyArray<{ workflowId: string }>;
  },
): string[] {
  const ids = new Set<string>();
  for (const thread of scope.threads) {
    // Chaque génération de la session du fil (0163) est une session de l'hôte.
    for (const key of threadSessionKeys(thread.sessionId, Number(thread.sessionGeneration ?? 0))) ids.add(key);
    ids.add(compactionSessionKey(organizationId, thread.threadId));
    // Lives on the default profile (DEV-OHB-244); a missing one is a 404.
    ids.add(greetingSessionKey(thread.sessionId));
  }
  for (const workflow of scope.workflows) {
    ids.add(workflowSessionKey(organizationId, workflow.workflowId, botId));
  }
  ids.add(personaDraftSessionKey(organizationId, botId));
  return [...ids];
}

/** Le profil nommé du bot sur l'hôte, ou `null` quand il n'a pas de profil à lui (absent ou `default`). */
export function namedHostProfileSlug(profile: string | null): string | null {
  if (!profile || profile === "default") return null;
  return profile;
}
