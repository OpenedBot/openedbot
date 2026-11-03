import type { RosterDto } from "@openedbot/contracts-api";
import { isPendingBotId } from "../bots/pending-bot-creations";
import { api, queryKeys } from "../api";
import { activeOrganizationId, readCloudSession } from "../session/cloud-session";
import { queryClient } from "../query-client";
import { restorePersistedQuery } from "../query-persister";
import { threadQueryOptions } from "../stream/use-thread-stream";

/**
 * A conversation's thread id lives on its bot (`bot.threadId`), so the screen
 * used to read the roster, render, and only then ask for the thread: one
 * round trip and several renders on the critical path of every refresh.
 *
 * The route loader starts both reads at once instead. The thread id comes from
 * `?task=`, else the roster already in cache, else the id this browser last
 * saw for the bot. A stale hint costs one unused read: the screen still opens
 * the thread named by the roster, exactly as before.
 */
const HINT_PREFIX = "ohb:bot-thread:";

function hintKey(botId: string): string | null {
  const organizationId = activeOrganizationId();
  return organizationId ? `${HINT_PREFIX}${organizationId}:${botId}` : null;
}

export function rememberBotThread(botId: string, threadId: string): void {
  const key = hintKey(botId);
  if (!key) return;
  try {
    if (globalThis.localStorage?.getItem(key) !== threadId) globalThis.localStorage?.setItem(key, threadId);
  } catch {
    // Private mode or quota: the next refresh simply waits for the roster.
  }
}

function hintedThreadId(botId: string): string | null {
  const key = hintKey(botId);
  if (!key) return null;
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function prefetchThread(threadId: string): void {
  void queryClient.prefetchQuery(threadQueryOptions(queryClient, threadId));
}

/**
 * The roster read resolves from IndexedDB within milliseconds after a refresh
 * (`lib/query-persister.ts`), long before the network answers: a thread id
 * found there starts the thread read without waiting for `/api/bots`.
 */
function prefetchRosterThen(threadIdOf: (roster: RosterDto) => string | undefined): void {
  void queryClient.prefetchQuery({ queryKey: queryKeys.roster, queryFn: api.roster }).then(() => {
    const roster = queryClient.getQueryData<RosterDto>(queryKeys.roster);
    const threadId = roster ? threadIdOf(roster) : undefined;
    if (threadId) prefetchThread(threadId);
  });
}

export function prefetchConversation(botId: string, task: string | undefined): void {
  const threadOf = (roster: RosterDto) => roster.bots.find((bot) => bot.id === botId)?.threadId;
  const cached = queryClient.getQueryData<RosterDto>(queryKeys.roster);
  const threadId = task ?? (cached ? threadOf(cached) : undefined) ?? hintedThreadId(botId);
  if (threadId) prefetchThread(threadId);
  prefetchRosterThen((roster) => (task ? undefined : threadOf(roster)));
}

export function prefetchGroupConversation(groupId: string): void {
  prefetchRosterThen((roster) => roster.groups?.find((group) => group.id === groupId)?.threadId);
}

/**
 * Starts the conversation reads from the app frame guard, before the session,
 * organization and onboarding checks resolve: the route loader would only run
 * after all three. Skipped without a local session or organization, where the
 * guard is about to redirect anyway.
 */
export function prefetchConversationForPath(pathname: string, search: Record<string, unknown>): void {
  if (!readCloudSession() || !activeOrganizationId()) return;
  const bot = /^\/bot\/([^/]+)\/?$/u.exec(pathname);
  if (bot?.[1]) {
    if (isPendingBotId(decodeURIComponent(bot[1]))) return;
    prefetchConversation(decodeURIComponent(bot[1]), typeof search.task === "string" ? search.task : undefined);
    return;
  }
  const group = /^\/g\/([^/]+)\/?$/u.exec(pathname);
  if (group?.[1]) prefetchGroupConversation(decodeURIComponent(group[1]));
}

/** Above this, a cold IndexedDB costs more than the skeleton it saves. */
const RESTORE_BUDGET_MS = 300;

/**
 * Before the conversation's first render: the roster and the thread this path
 * opens, read back from IndexedDB into the cache, so the frame paints them
 * at once from the boot silhouette. Bounded: past the budget the screen
 * renders its skeletons as before, and the reads land when they land.
 */
export async function restoreConversationForPath(pathname: string, search: Record<string, unknown>): Promise<void> {
  if (!readCloudSession() || !activeOrganizationId()) return;
  const bot = /^\/bot\/([^/]+)\/?$/u.exec(pathname);
  const group = /^\/g\/([^/]+)\/?$/u.exec(pathname);
  // Only on a refresh: once the roster is in memory, navigation never waits.
  if ((!bot?.[1] && !group?.[1]) || queryClient.getQueryData(queryKeys.roster) !== undefined) return;
  const restore = (async () => {
    const roster = await restorePersistedQuery(queryClient, queryKeys.roster) as RosterDto | undefined;
    let threadId: string | null | undefined;
    if (bot?.[1]) {
      const botId = decodeURIComponent(bot[1]);
      threadId = (typeof search.task === "string" ? search.task : undefined)
        ?? roster?.bots.find((entry) => entry.id === botId)?.threadId
        ?? hintedThreadId(botId);
    } else if (group?.[1]) {
      const groupId = decodeURIComponent(group[1]);
      threadId = roster?.groups?.find((entry) => entry.id === groupId)?.threadId;
    }
    if (threadId) await restorePersistedQuery(queryClient, queryKeys.thread(threadId));
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([restore, new Promise<void>((resolve) => { timer = setTimeout(resolve, RESTORE_BUDGET_MS); })]);
  clearTimeout(timer);
}
