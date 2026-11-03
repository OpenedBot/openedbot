/**
 * Un bot dont le profil Hermes n'existe plus sur le runtime actuel.
 *
 * `bots.hermes_profile` ne nomme qu'un slug, sans runtime : quand l'organisation
 * remplace son runtime (VPS perdu, nouvelle VM), le slug pointe vers un profil
 * que le nouvel hôte n'a jamais eu. Le gateway répond 404 sous `/p/<slug>/`
 * et chaque run échouait sur « inventaire d'outils absent », ce qui envoyait
 * l'opérateur vers le mauvais problème.
 *
 * Ce module dit ce qu'openedbot peut recréer seul sur le nouvel hôte (ce qu'il garde
 * en base) et ce qui est resté sur l'ancien (ce qui ne vivait que dans le
 * profil). Le transfert recrée le même profil avec ce qui suit le bot ; la
 * réinitialisation repart d'un profil neuf sur le modèle du runtime, quand le
 * modèle propre du bot n'y est pas disponible.
 */

import type { BotProfileCarried, BotProfileLost } from "@openedbot/contracts-api";

export const BOT_PROFILE_MISSING_CODE = "HERMES_PROFILE_MISSING";

/**
 * Ce qu'openedbot tient en base et rejoue sur le nouveau profil, ou à chaque run :
 * nom et apparence, modèle propre, persona (envoyée par run), historique des fils.
 */
export const BOT_PROFILE_CARRIED: readonly BotProfileCarried[] = ["identity", "model", "persona", "conversations"];

/**
 * Ce qui ne vivait que dans le profil de l'ancien hôte : `MEMORY.md` / `USER.md`,
 * clés de fournisseur du profil, toolsets / MCP / skills activés, sessions Hermes.
 */
export const BOT_PROFILE_LOST: readonly BotProfileLost[] = ["memory", "credentials", "capabilities", "sessions"];

/** La réinitialisation ne garde pas le modèle propre : le profil neuf suit le runtime. */
export function botProfileCarried(mode: "transfer" | "reset"): BotProfileCarried[] {
  return BOT_PROFILE_CARRIED.filter((item) => mode === "transfer" || item !== "model");
}

export function botProfileMissingMessage(profile: string): string {
  return `Le profil Hermes « ${profile} » de ce bot n’existe pas sur le runtime actuel, souvent parce que le runtime a été remplacé. `
    + "Ouvrez les réglages du bot pour transférer ce qui peut l’être, ou le réinitialiser sur ce runtime.";
}
