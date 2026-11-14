import { createRoute, lazyRouteComponent, type AnyRoute } from "@tanstack/react-router";
import { prefetchGroupConversation } from "./lib/thread/conversation-prefetch";
import { readGlobalSearchFocus } from "./lib/thread/global-search-focus";

const GroupConversationScreen = lazyRouteComponent(() => import("./screens/conversation/group-conversation"), "GroupConversationScreen");
const NewGroupChatRoute = lazyRouteComponent(() => import("./screens/conversation/new-group-chat"), "NewGroupChatRoute");

/**
 * Group rooms, under the app frame (`route-tree.tsx`).
 *
 * - `/g/new?with=<botId>,…`: a new group conversation, the reference app's
 *   `NewChatBar` (« À : » and bots as pills). Static path: it matches
 *   before `/g/$groupId`.
 * - `/g/$groupId`: a room, the same frame as a bot, a different header.
 */
export function groupRoutes<TParent extends AnyRoute>(parent: TParent) {
  const newGroupChat = createRoute({
    getParentRoute: () => parent,
    path: "/g/new",
    validateSearch: (search: Record<string, unknown>): { with?: string } => ({
      with: typeof search.with === "string" && search.with ? search.with : undefined,
    }),
    component: NewGroupChatRoute,
  });
  const groupConversation = createRoute({
    getParentRoute: () => parent,
    path: "/g/$groupId",
    validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
      focus: readGlobalSearchFocus(search.focus),
    }),
    // Not awaited, like the bot conversation: roster then the room's thread.
    loader: ({ params }) => prefetchGroupConversation(params.groupId),
    component: GroupConversationScreen,
  });
  return [newGroupChat, groupConversation] as const;
}
