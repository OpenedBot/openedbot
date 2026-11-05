/**
 * What a pro console module gives the console (open-core step 9).
 *
 * The console builds its pro screens from `virtual:openedbot-pro-console`
 * (`vite-pro-console.ts`): solo, the list is empty and no fleet, billing or
 * permission-rules screen enters the bundle; pro, each entry of
 * `OPENEDBOT_CONSOLE_PLUGINS` is one of these modules. A feature is shown only when its
 * module is present AND the session holds its entitlement (`/api/auth/me`).
 *
 * The slot types are written out here (open-core step 11): the screens live
 * in the external plugin repo, and the core reads them only through this
 * contract and `slots.tsx`.
 */
import type { ComponentType, ReactNode } from "react";
import type { AccountWorkspace, BotDto } from "@openedbot/contracts-api";
import type { RouteComponent } from "@tanstack/react-router";
import type { FLEET_SECTIONS } from "../components/workspace/workspace-navigation";

/** The entitlement each feature needs (`modules/identity/src/application/entitlements.ts`). */
export const PRO_CONSOLE_ENTITLEMENTS = {
  fleet: "fleet.workspaces",
  billing: "billing.enforced",
  permissions: "permissions.rules",
} as const;

export type ProConsoleFeature = keyof typeof PRO_CONSOLE_ENTITLEMENTS;

/** A route screen: a `lazyRouteComponent`, preloaded by the router. */
type RouteScreen = RouteComponent;

/**
 * The fleet: an organization that operates client workspaces, filled by an
 * external plug-in. The core names its slots neutrally (`fleet`, `Fleet*`);
 * the wire fields `agencyAvailable` and `viaAgencyIds` are the server's
 * and keep their names (dated debt, open-core step 11.2). Its route screens are
 * lazy; the frame parts are read by the core frames on every render and are
 * therefore static. Its gate is `agencyAvailable` from
 * `/api/account/workspaces`, the per-account reading of the entitlement.
 */
export type FleetConsole = {
  entitlement: typeof PRO_CONSOLE_ENTITLEMENTS.fleet;
  screens: {
    FleetScreen: RouteScreen;
    FleetClientSummary: RouteScreen;
    FleetClientConversations: RouteScreen;
    FleetClientsSettings: ComponentType;
    FleetJournalSettings: ComponentType;
    /** `/invite/fleet/$token`: a client accepts the operating organization. */
    FleetInvitationScreen: RouteScreen;
  };
  frame: {
    /** The fleet frame around the tab's workspace, or `null` outside one. */
    useFleetFrameContext: () => FleetFrameContext | null;
    /** The client section a frame path belongs to (`/settings/agents/import` is `/settings/agents`). */
    fleetSectionOf: (pathname: string) => FleetSectionPath;
    FleetRail: ComponentType<{ client?: AccountWorkspace | null; fleetId?: string; expanded?: boolean }>;
    FleetTopBar: ComponentType<{
      client?: AccountWorkspace | null; fleetWorkspace?: AccountWorkspace | null; clientDestination?: string;
      target?: string; className?: string; children?: ReactNode;
    }>;
    FleetClientFrame: ComponentType<{
      /** `null` on the fleet's own pages (team, account): no client tabs. */
      fleet: AccountWorkspace; client: AccountWorkspace | null;
      slotRef?: (element: HTMLDivElement | null) => void; aside?: ReactNode; children: ReactNode;
    }>;
    FleetClientLoading: ComponentType<{ path: string; fallback: ReactNode }>;
    FleetClientSettingsContext: ComponentType<{ children: ReactNode }>;
    /** Loading guess: the tab's active organization is one of the account's own fleets. */
    activeOwnFleetHint: () => boolean;
  };
  journal: {
    FleetA2APolicySettings: ComponentType<{ mobile?: boolean; onMobileFooterChange?: (footer: ReactNode | null) => void }>;
    FleetClientAudit: ComponentType<{ decisions?: ReactNode }>;
    /** The client frame whose audit this page may read, or `null` outside a live grant. */
    useFleetAuditScope: () => FleetAuditScope | null;
  };
};

/** A client section path of the frame (`FLEET_SECTIONS`). */
export type FleetSectionPath = (typeof FLEET_SECTIONS)[number][1];
export type FleetFrameContext = { fleet: AccountWorkspace; client: AccountWorkspace | null };
export type FleetAuditScope = { userId: string; fleetId: string; clientId: string; client: AccountWorkspace };

/** The billing screen (dev settings), from the pro plug-in `pro-billing/console` since step 8d. */
export type BillingConsole = {
  entitlement: typeof PRO_CONSOLE_ENTITLEMENTS.billing;
  BillingSettings: ComponentType;
};

/** Permission rules (pro-permissions): one card per bot, one per organization. */
export type PermissionsConsole = {
  entitlement: typeof PRO_CONSOLE_ENTITLEMENTS.permissions;
  BotPermissionRules: ComponentType<{ bot: BotDto }>;
  OrganizationPermissionRulesSettings: ComponentType;
};

export type ProConsoleModule = {
  /** The plug-in id, for diagnostics. */
  id: string;
  /**
   * The current address for a URL this module published before (an e-mail
   * link, a bookmark), or `null` when it is not one of them. The core holds
   * no old address of its own: solo, an old URL is simply not found.
   */
  legacyHref?: (url: URL) => string | null;
  fleet?: FleetConsole;
  billing?: BillingConsole;
  permissions?: PermissionsConsole;
};

export type ProConsoleFeatures = {
  fleet?: FleetConsole;
  billing?: BillingConsole;
  permissions?: PermissionsConsole;
};
