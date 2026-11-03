import { createRoute, lazyRouteComponent, type AnyRoute } from "@tanstack/react-router";
import { prefetchGroupConversation } from "./lib/thread/conversation-prefetch";
import { readGlobalSearchFocus } from "./lib/thread/global-search-focus";

const GroupConversationScreen = lazyRouteComponent(() => import("./screens/conversation/group-conversation"), "GroupConversationScreen");
const NewGroupChatRoute = lazyRouteComponent(() => import("./screens/conversation/new-group-chat"), "NewGroupChatRoute");

/**
 * Les salons de groupe, sous le cadre de l'app (`route-tree.tsx`).
 *
 * - `/g/new?with=<botId>,…` : une nouvelle conversation de groupe, le
 *   `NewChatBar` de Grok Bot (« À : » et des bots en pastilles). Chemin
 *   statique : il passe avant `/g/$groupId`.
 * - `/g/$groupId` : un salon, même cadre qu'un bot, en-tête différent.
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
