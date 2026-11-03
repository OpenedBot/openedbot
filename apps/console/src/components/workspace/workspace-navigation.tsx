import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { DialogContextLabel, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { AccountWorkspace, AccountWorkspacesDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { activeOrganizationId, readCloudSession } from "../../lib/session/cloud-session";
import { isOwnFleet, ORGANIZATION_SETUP_PATH, ownWorkspaces } from "../../lib/session/organization-gate";
import { personalWorkspaces, rememberAccountWorkspaces, rememberPersonalWorkspaces, rememberWorkspaces } from "../../lib/workspace/workspace-directory";
import { fleetHomeHref, fleetInPath, internalWorkspacePath, operatingFleetId, workspaceFrameInPath, workspaceHref, workspaceInPath } from "../../lib/workspace/workspace-location";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../lib/shell/settings-overlay";
import { rememberSettingsReturn } from "../../lib/shell/settings-return";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";

/**
 * Un compte qui tient une agence, y opère un client, ou a donné mandat à une
 * agence. Lui seul perd quelque chose quand la fonction agence se ferme : un
 * compte purement personnel n'a ni contexte à quitter ni écran à fermer.
 */
function hasFleetStake(account: AccountWorkspacesDto | undefined): boolean {
  return account?.workspaces.some((workspace) =>
    workspace.kind === "agency" || workspace.role === "agency" || (workspace.viaAgencyIds?.length ?? 0) > 0) ?? false;
}

export function useAccountWorkspaces() {
  const queryClient = useQueryClient();
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
    // Le serveur refuse déjà un contexte retiré (403 `WORKSPACE_ACCESS_REVOKED`,
    // `stream.revoked` sur le SSE) : ce relevé ne sert qu'à fermer l'écran
    // agence à temps, donc seulement pour un compte qui en a un.
    refetchInterval: (current) => hasFleetStake(current.state.data) ? 10_000 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const fleetStake = hasFleetStake(query.data);
  const [, setFreshnessTick] = useState(0);
  useEffect(() => {
    if (!fleetStake || !query.dataUpdatedAt) return;
    const expiresIn = 25_000 - (Date.now() - query.dataUpdatedAt);
    if (expiresIn <= 0) return;
    const timer = setTimeout(() => setFreshnessTick((value) => value + 1), expiresIn);
    return () => clearTimeout(timer);
  }, [fleetStake, query.dataUpdatedAt]);

  // Sans relevé périodique, un compte personnel ne peut pas exiger un relevé
  // de moins de 25 s : il garderait `agencyAvailable` à faux après 25 s et
  // perdrait l'offre « créer une agence ». Le fail-closed ne vaut que là où
  // il y a un accès agence à fermer.
  const featureReadFresh = query.dataUpdatedAt > 0 &&
    (!fleetStake || Date.now() - query.dataUpdatedAt < 25_000);
  const agencyAvailable = query.data?.agencyAvailable === true && !query.error && featureReadFresh;
  const data = useMemo(() => query.data ? {
    ...query.data,
    agencyAvailable,
    workspaces: agencyAvailable ? query.data.workspaces : personalWorkspaces(query.data.workspaces),
  } : undefined, [agencyAvailable, query.data]);

  useEffect(() => {
    if (agencyAvailable || (!query.data && !query.error)) return;
    if (query.data) rememberWorkspaces(personalWorkspaces(query.data.workspaces), query.data.userId);
    else rememberPersonalWorkspaces(session?.userId);
    const isFleetData = (entry: { queryKey: readonly unknown[] }) =>
      ["agency-fleet", "agency-client", "fleet-grants"].includes(String(entry.queryKey[0]));
    void queryClient.cancelQueries({ predicate: isFleetData });
    queryClient.removeQueries({ predicate: isFleetData });
  }, [agencyAvailable, query.data, query.error, queryClient, session?.userId]);

  return { ...query, data };
}

/** Label, internal path, and URL key (`/o/<agency>/fleet/choose/<key>`) of each client section. */
export const FLEET_SECTIONS = [
  ["fleet.summary", "/summary", "summary"],
  ["fleet.conversations", "/conversations", "conversations"], ["fleet.agents", "/settings/agents", "agents"],
  ["fleet.policy", "/settings/policies", "policies"], ["fleet.audit", "/settings/decisions", "audit"],
  ["fleet.settings", "/settings", "settings"],
] as const;

/** The section a URL value names, by key (`policies`) or by its legacy path (`/settings/policies`). */
export function fleetSection(value: string | null | undefined): (typeof FLEET_SECTIONS)[number] | null {
  return FLEET_SECTIONS.find(([, path, key]) => value === key || value === path) ?? null;
}

/** An explicit agency key must name an agency the account belongs to. */
export function selectFleetOrganization(workspaces: readonly AccountWorkspace[], key?: string | null): AccountWorkspace | null {
  const agencies = workspaces.filter(isOwnFleet);
  if (key == null) return agencies[0] ?? null;
  const selected = key.toLowerCase();
  return agencies.find((workspace) => workspace.id.toLowerCase() === selected || workspace.slug.toLowerCase() === selected) ?? null;
}


/**
 * Opens a public workspace URL without reloading the page. The URL already
 * names its organization (`/o/<slug>/...`), so it goes to the history as is:
 * `navigate({ href })` would pass it through the output rewrite, which writes
 * the organization the tab is leaving.
 *
 * A settings section of the frame on screen opens in the settings overlay, over
 * the current screen. Another frame's settings (the fleet opening a client's
 * runtime), an address with an anchor, and any section in the agency frame
 * (where settings are a page, no overlay is provided) go through the route.
 */
export function useWorkspaceNavigate(): (href: string) => void {
  const router = useRouter();
  const overlay = useSettingsOverlay();
  return useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
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

/** An anchor to a workspace URL: a plain click stays in the app, a modified one keeps the browser's behavior. */
export function WorkspaceLink({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const navigate = useWorkspaceNavigate();
  return <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target) return;
    event.preventDefault();
    navigate(href);
  }} />;
}

/** Where a workspace opens: an agency organization opens its fleet, anything else its own frame. */
function workspaceHomeHref(workspace: AccountWorkspace): string {
  return isOwnFleet(workspace) ? fleetHomeHref(workspace.id)
    : workspaceHref(workspace.id, "/", workspace.role === "agency" ? undefined : null);
}

export type WorkspaceSwitch = {
  activeId: string | null;
  groups: ReadonlyArray<{ label: "fleet.personal" | "fleet.agencies" | "fleet.clients"; workspaces: AccountWorkspace[] }>;
  open: (workspace: AccountWorkspace) => void;
};

/**
 * The organization switch of the desktop sidebar head, with the same rules as
 * `WorkspaceSelector`: `null` when there is nothing to switch to (a single
 * workspace, an impersonated session, or a client workspace whose agency rail
 * already carries the navigation).
 */
export function useWorkspaceSwitch(): WorkspaceSwitch | null {
  const account = useAccountWorkspaces();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const navigate = useWorkspaceNavigate();
  const workspaces = account.data?.workspaces;
  const impersonating = me.data?.kind === "session" && me.data.session.impersonation !== null;
  // Read on every render: the active organization is the URL's, not a query.
  const activeId = activeOrganizationId() ?? null;
  return useMemo(() => {
    if (!workspaces || workspaces.length < 2 || impersonating) return null;
    const active = workspaces.find((w) => w.id === activeId);
    if (active?.role === "agency") return null;
    const own = ownWorkspaces(workspaces);
    // In the agency frame its sidebar lists the clients: the switch only changes organization.
    const inFleet = active !== undefined && isOwnFleet(active);
    const groups = ([
      { label: "fleet.personal", workspaces: own.filter((w) => w.kind === "personal") },
      { label: "fleet.agencies", workspaces: own.filter((w) => w.kind === "agency") },
      { label: "fleet.clients", workspaces: inFleet ? [] : workspaces.filter((w) => w.role === "agency") },
    ] as const).filter((group) => group.workspaces.length > 0);
    if (groups.reduce((total, group) => total + group.workspaces.length, 0) < 2) return null;
    return { activeId, groups, open: (workspace) => navigate(workspaceHomeHref(workspace)) };
  }, [activeId, impersonating, navigate, workspaces]);
}

/**
 * Personal and Agency are distinct organizations (0086): switching between
 * them is switching organization, grouped as Personal, Agencies, then the
 * clients reached through an agency.
 */
export function WorkspaceSelector({ hideCreateWhenSolo = false }: { hideCreateWhenSolo?: boolean } = {}) {
  const { t } = useT();
  const account = useAccountWorkspaces();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const navigate = useWorkspaceNavigate();
  if (!account.data || me.data?.session.impersonation) return null;
  // Inside a client workspace the agency rail carries the navigation.
  if (account.data.workspaces.find((w) => w.id === activeOrganizationId())?.role === "agency") return null;
  const workspaces = account.data.workspaces;
  const own = ownWorkspaces(workspaces);
  const personal = own.filter((w) => w.kind === "personal");
  const agencies = own.filter((w) => w.kind === "agency");
  const clients = workspaces.filter((w) => w.role === "agency");
  // Personne unique : un seul workspace au total, personnel, sans agence ni client.
  const solo = workspaces.length === 1 && personal.length === 1 && agencies.length === 0 && clients.length === 0;
  const canCreate = (personal.length === 0 || account.data.agencyAvailable) && !(hideCreateWhenSolo && solo);
  const option = (w: AccountWorkspace) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>;
  return <div className="space-y-2 text-sm group-data-[collapsible=icon]:hidden">
    {workspaces.length > 1 && <Select value={activeOrganizationId() ?? undefined} onValueChange={(value) => {
      const target = workspaces.find((w) => w.id === value);
      if (target) navigate(workspaceHomeHref(target));
    }}>
      <SelectTrigger aria-label={t("fleet.chooseWorkspace")} className="w-full"><SelectValue placeholder={t("fleet.chooseWorkspace")} /></SelectTrigger>
      <SelectContent>
        {personal.length > 0 && <SelectGroup><SelectLabel>{t("fleet.personal")}</SelectLabel>{personal.map(option)}</SelectGroup>}
        {agencies.length > 0 && <SelectGroup><SelectLabel>{t("fleet.agencies")}</SelectLabel>{agencies.map(option)}</SelectGroup>}
        {clients.length > 0 && <SelectGroup><SelectLabel>{t("fleet.clients")}</SelectLabel>{clients.map(option)}</SelectGroup>}
      </SelectContent>
    </Select>}
    {canCreate && <a className={BUTTON.secondary} href={`${ORGANIZATION_SETUP_PATH}?create=1`}>{t("fleet.createOrganization")}</a>}
  </div>;
}

export function WorkspaceDialogScope({ children }: { children: ReactNode }) {
  const { t } = useT();
  const account = useAccountWorkspaces();
  const current = account.data?.workspaces.find((w) => w.id === activeOrganizationId());
  const fleetPath = fleetInPath(globalThis.window?.location.pathname ?? "");
  const underMandate = current && fleetPath && operatingFleetId(current);
  const label = current && (current.role === "agency" || underMandate)
    ? t("fleet.selectedClient", { name: current.name }) : null;
  return <DialogContextLabel.Provider value={label}>{children}</DialogContextLabel.Provider>;
}
