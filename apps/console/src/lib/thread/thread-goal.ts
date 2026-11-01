import { useCallback, useEffect, useState } from "react";

/**
 * L'objectif d'un fil (menu « + » → Objectif) : une phrase que le composer
 * place devant chaque message tant qu'elle est posée. Gardé par bot dans le
 * navigateur, comme le brouillon : c'est une aide d'écriture, pas un réglage
 * du bot.
 */
const key = (scope: string) => `ohb.threadGoal.${scope}`;

function read(scope: string): string | null {
  try {
    return window.localStorage.getItem(key(scope))?.trim() || null;
  } catch {
    return null;
  }
}

export function useThreadGoal(scope: string): [string | null, (goal: string | null) => void] {
  const [goal, setGoalState] = useState<string | null>(() => read(scope));
  useEffect(() => setGoalState(read(scope)), [scope]);
  const setGoal = useCallback((next: string | null) => {
    const value = next?.trim().slice(0, 280) || null;
    try {
      if (value) window.localStorage.setItem(key(scope), value);
      else window.localStorage.removeItem(key(scope));
    } catch {
      // Stockage refusé : l'objectif vit le temps de la page.
    }
    setGoalState(value);
  }, [scope]);
  return [goal, setGoal];
}

/** Le message réellement envoyé : l'objectif d'abord, puis le texte. */
export function withThreadGoal(input: string, goal: string | null, label: string): string {
  return goal ? `${label} ${goal}\n\n${input}` : input;
}
