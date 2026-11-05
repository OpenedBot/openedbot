import { useCallback, useEffect, useState } from "react";
import { readCloudSession } from "../session/cloud-session";

/**
 * L'objectif d'un fil (menu « + » → Objectif) : une phrase que le composer
 * place devant chaque message tant qu'elle est posée. Gardé par bot dans le
 * navigateur, comme le brouillon : c'est une aide d'écriture, pas un réglage
 * du bot. Comme lui, la clé porte l'utilisateur et l'organisation, et la
 * déconnexion efface tout (`clearThreadGoals`) : sur un poste partagé, le
 * compte suivant ne doit ni voir ni envoyer l'objectif du précédent.
 */
const PREFIX = "openedbot.threadGoal.";

function storageKey(scope: string): string | null {
  const session = readCloudSession();
  return session?.userId && session.organizationId ? `${PREFIX}${session.userId}:${session.organizationId}:${scope}` : null;
}

function read(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key)?.trim() || null;
  } catch {
    return null;
  }
}

export function useThreadGoal(scope: string): [string | null, (goal: string | null) => void] {
  const key = storageKey(scope);
  const [goal, setGoalState] = useState<string | null>(() => read(key));
  useEffect(() => setGoalState(read(key)), [key]);
  const setGoal = useCallback((next: string | null) => {
    const value = next?.trim().slice(0, 280) || null;
    try {
      // Sans compte identifié, l'objectif vit le temps de la page.
      if (key && value) window.localStorage.setItem(key, value);
      else if (key) window.localStorage.removeItem(key);
    } catch {
      // Stockage refusé : l'objectif vit le temps de la page.
    }
    setGoalState(value);
  }, [key]);
  return [goal, setGoal];
}

/** Déconnexion : tous les objectifs gardés sur ce poste, anciens formats compris. */
export function clearThreadGoals(): void {
  try {
    const store = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch { /* Stockage indisponible : rien n'y a été gardé non plus. */ }
}

/** Le message réellement envoyé : l'objectif d'abord, puis le texte. */
export function withThreadGoal(input: string, goal: string | null, label: string): string {
  return goal ? `${label} ${goal}\n\n${input}` : input;
}
