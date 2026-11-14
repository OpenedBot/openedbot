import { useCallback, useEffect, useState } from "react";
import { readCloudSession } from "../session/cloud-session";

/**
 * A thread's goal (menu « + » → Objectif): a sentence the composer
 * places in front of every message for as long as it is set. Kept per bot in the
 * browser, like the draft: it is a writing aid, not a setting
 * of the bot. Like it, the key carries the user and the organization, and
 * sign-out clears everything (`clearThreadGoals`): on a shared machine, the
 * next account must neither see nor send the previous one's goal.
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
      // Without an identified account, the goal lives for the life of the page.
      if (key && value) window.localStorage.setItem(key, value);
      else if (key) window.localStorage.removeItem(key);
    } catch {
      // Storage refused: the goal lives for the life of the page.
    }
    setGoalState(value);
  }, [key]);
  return [goal, setGoal];
}

/** Sign-out: every goal kept on this machine, older formats included. */
export function clearThreadGoals(): void {
  try {
    const store = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch { /* Storage unavailable: nothing was kept there either. */ }
}

/** The message actually sent: the goal first, then the text. */
export function withThreadGoal(input: string, goal: string | null, label: string): string {
  return goal ? `${label} ${goal}\n\n${input}` : input;
}
