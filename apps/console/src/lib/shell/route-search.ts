import { readGlobalSearchFocus } from "../thread/global-search-focus";

/*
  The search-parameter readers of `route-tree.tsx`: each keeps only the values
  its route understands, so a hand-edited URL never reaches a screen as is.
*/

type Search = Record<string, unknown>;

/** `/login`: where to go back, why the session ended, the e-mail to prefill. */
export const loginSearch = (search: Search): { redirect?: string; reason?: string; email?: string } => ({
  redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  reason: typeof search.reason === "string" ? search.reason : undefined,
  email: typeof search.email === "string" ? search.email : undefined,
});

/** `/onboarding`: `?review=1` replays the steps already done. */
export const onboardingSearch = (search: Search): { review?: number } => (search.review ? { review: 1 } : {});

/** « À traiter » (`/settings/inbox`, and the former `/inbox`): the filter. */
export type InboxSearch = { kind?: "approval" | "needs_review" | "needs_you" };
export const inboxSearch = (search: Search): InboxSearch => ({
  kind: search.kind === "approval" || search.kind === "needs_review" || search.kind === "needs_you" ? search.kind : undefined,
});

/** A bot's thread: the message-variant branch (`?task=`) and the search hit to focus. */
export function conversationSearch(search: Search): { task?: string; focus?: string } {
  return {
    task: typeof search.task === "string" && search.task.length <= 128 ? search.task : undefined,
    focus: readGlobalSearchFocus(search.focus),
  };
}
