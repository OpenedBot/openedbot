import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { AccountWorkspace } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { activeOrganizationId, readCloudSession } from "../../lib/session/cloud-session";
import { personalWorkspaces, rememberAccountWorkspaces } from "../../lib/workspace/workspace-directory";
import { internalWorkspacePath, workspaceFrameInPath, workspaceHref } from "../../lib/workspace/workspace-location";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../lib/shell/settings-overlay";
import { rememberSettingsReturn } from "../../lib/shell/settings-return";
import { appUrl } from "../../lib/platform";

export function useAccountWorkspaces() {
  const session = readCloudSession();
  const query = useQuery({
    queryKey: queryKeys.accountWorkspaces(session?.userId ?? "session"),
    queryFn: async () => {
      // The read the access guards started (or just settled) is reused: the
      // frame now mounts before they finish, and asked again 100 ms later.
      const account = await api.accountWorkspacesForNavigation();
      rememberAccountWorkspaces(account);
      return account;
    },
    enabled: Boolean(session),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const data = useMemo(() => query.data ? {
    ...query.data,
    workspaces: personalWorkspaces(query.data.workspaces),
  } : undefined, [query.data]);
  return { ...query, data };
}

/**
 * Opens a public workspace URL without reloading the page. The URL already
 * names its organization (`/o/<slug>/...`), so it goes to the history as is:
 * `navigate({ href })` would pass it through the output rewrite, which writes
 * the organization the tab is leaving.
 *
 * A settings section of the frame on screen opens in the settings overlay, over
 * the current screen. Another organization's settings, and an address with an
 * anchor, go through the route.
 */
function useWorkspaceNavigate(): (href: string) => void {
  const router = useRouter();
  const overlay = useSettingsOverlay();
  return useCallback((href: string) => {
    const url = appUrl(href);
    const internal = internalWorkspacePath(url.pathname);
    if (internal.startsWith("/settings")) {
      const sameFrame = workspaceFrameInPath(url.pathname) === workspaceFrameInPath(window.location.pathname);
      if (overlay && sameFrame && !url.search && !url.hash && isOverlaySettingsPath(internal)) {
        overlay.open(internal);
        return;
      }
      rememberSettingsReturn(href);
    }
    router.history.push(href);
  }, [router, overlay]);
}

export type WorkspaceSwitch = {
  activeId: string | null;
  workspaces: AccountWorkspace[];
  open: (workspace: AccountWorkspace) => void;
};

/**
 * The organization switch of the desktop sidebar head: `null` when there is
 * nothing to switch to (a single workspace, or an assisted session).
 */
export function useWorkspaceSwitch(): WorkspaceSwitch | null {
  const account = useAccountWorkspaces();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const navigate = useWorkspaceNavigate();
  const workspaces = account.data?.workspaces;
  const assisted = me.data?.kind === "session" && me.data.session.impersonation !== null;
  // Read on every render: the active organization is the URL's, not a query.
  const activeId = activeOrganizationId() ?? null;
  return useMemo(() => {
    if (!workspaces || workspaces.length < 2 || assisted) return null;
    return { activeId, workspaces, open: (workspace) => navigate(workspaceHref(workspace.id)) };
  }, [activeId, assisted, navigate, workspaces]);
}
