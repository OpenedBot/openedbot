/**
 * Le nom d'utilisateur de l'opérateur : la règle de forme, partagée.
 *
 * Le handle est un slug au même alphabet que ceux des bots (`[a-z0-9-]`) :
 * c'est ce que `@…` reconnaît partout (`mentions.ts`, protocole cloud API). Une
 * seule implémentation : le cloud API l'applique (source de vérité), les deux
 * clients la réutilisent pour montrer en direct « vos bots vous appelleront
 * @elodie » : deux copies auraient divergé au premier accent.
 */
import { OPERATOR_USERNAME_MAX, OPERATOR_USERNAME_MIN, OPERATOR_USERNAME_RESERVED } from "@openedbot/contracts-api";

/** NFD, minuscules, tout ce qui n'est ni lettre ni chiffre devient `-`, pas de tiret aux bords. */
export function normalizeUsername(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type UsernameProblem = "invalid" | "reserved";

/** `null` si le handle normalisé est acceptable, sinon pourquoi il ne l'est pas. */
export function usernameProblem(username: string): UsernameProblem | null {
  if (username.length < OPERATOR_USERNAME_MIN || username.length > OPERATOR_USERNAME_MAX) return "invalid";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(username)) return "invalid";
  if (OPERATOR_USERNAME_RESERVED.includes(username)) return "reserved";
  return null;
}
