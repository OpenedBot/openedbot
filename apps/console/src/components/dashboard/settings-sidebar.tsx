import {
  IconActivity,
  IconBell,
  IconArchive,
  IconBrain,
  IconCreditCard,
  IconHistory,
  IconInbox,
  IconLayoutGrid,
  IconPlugConnected,
  IconPalette,
  IconDeviceLaptop,
  IconRefresh,
  IconServerBolt,
  IconTerminal2,
  IconShield,
  IconShieldCheck,
  IconUserCircle,
} from "@tabler/icons-react";
import { SHOW_DEV_SETTINGS } from "../../lib/shell/dev-settings-ui";
import type { MessageKey } from "../../lib/i18n";
import { useProFeature } from "../../pro-console/registry";

/**
 * The settings sections, source of the navigation of the modal and of the
 * page (`boardui/settings-modal.tsx`) and of the mobile screen.
 *
 * Ordered by what one comes to find (31-10) rather than by technical
 * layer: Me (account, appearance), the Workspace (activity,
 * archives), the Bots and their runtime (runtime, models, connectors),
 * Control (policies, decisions, security). « Importer des agents » is a
 * tab of Runtime (its column of sections), not a section: its route
 * stays, and it lights Runtime (`also`). Notifications include personal email preferences.
 *
 * A last group, « Développement », gathers EVERYTHING that shows only
 * under `make dev` (Billing, Dev tools). Before, these surfaces were
 * scattered in the product groups: Billing between Organization and
 * Appearance, the home tools at the bottom of Profile: and nothing said on
 * reading that they would disappear from the build. One group, one
 * switch: `SHOW_DEV_SETTINGS`.
 */
type SettingsGroupItem = {
  titleKey: MessageKey;
  url: string;
  icon: typeof IconLayoutGrid;
  exact?: boolean;
  disabled?: boolean;
  /** Other routes that belong to this entry and light it up. */
  also?: readonly string[];
};

type SettingsGroup = {
  labelKey: MessageKey;
  items: SettingsGroupItem[];
};

/**
 * The dev group, defined apart so it reads as one block: what enters here
 * does not exist in production, and nothing else must enter it.
 */
const SETTINGS_DEV_GROUP: SettingsGroup = {
  labelKey: "settingsSidebar.groupDev",
  items: [
    { titleKey: "settingsSidebar.billing", url: "/settings/billing", icon: IconCreditCard },
    { titleKey: "settingsSidebar.developer", url: "/settings/developer", icon: IconTerminal2 },
  ],
};

/** Static structure: the labels resolve at display time via `useT()`. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelKey: "settingsSidebar.groupMe",
    items: [
      { titleKey: "settingsSidebar.account", url: "/settings/account", icon: IconUserCircle },
      { titleKey: "settingsSidebar.notifications", url: "/settings/notifications", icon: IconBell },
      { titleKey: "settingsSidebar.appearance", url: "/settings/appearance", icon: IconPalette },
      // Tauri app only: the desktop app update (constant at build).
      ...(import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" ? [{ titleKey: "settingsSidebar.updates" as const, url: "/settings/updates", icon: IconRefresh }] : []),
      // Tauri app on Mac only: the notch (the shell states its system before the first script).
      ...(import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" && globalThis.window?.__OPENEDBOT_SHELL__?.platform === "macos"
        ? [{ titleKey: "settingsSidebar.notch" as const, url: "/settings/notch", icon: IconDeviceLaptop }]
        : []),
    ],
  },
  {
    labelKey: "settingsSidebar.groupWorkspace",
    items: [
      { titleKey: "settingsSidebar.overview", url: "/settings/activity", icon: IconActivity, exact: true },
      { titleKey: "inbox.title", url: "/settings/inbox", icon: IconInbox },
      { titleKey: "settingsSidebar.archives", url: "/settings/archives", icon: IconArchive },
    ],
  },
  {
    labelKey: "settingsSidebar.groupBots",
    items: [
      { titleKey: "settingsSidebar.runtime", url: "/settings/runtime", icon: IconServerBolt, also: ["/settings/agents"] },
      { titleKey: "settingsSidebar.models", url: "/settings/models", icon: IconBrain },
      { titleKey: "settingsSidebar.connectors", url: "/settings/connectors", icon: IconPlugConnected },
    ],
  },
  {
    labelKey: "settingsSidebar.groupControl",
    items: [
      { titleKey: "settingsSidebar.policies", url: "/settings/policies", icon: IconShieldCheck },
      { titleKey: "settingsSidebar.decisions", url: "/settings/decisions", icon: IconHistory },
      { titleKey: "settingsSidebar.security", url: "/settings/security", icon: IconShield },
    ],
  },
  ...(SHOW_DEV_SETTINGS ? [SETTINGS_DEV_GROUP] : []),
];

/**
 * An `exact` entry lights on its own path only (and stays off the phone's
 * list). The others also light on their subpaths: a runtime detail must not
 * turn off « Edge ».
 */
export function isSettingsEntryActive(pathname: string, url: string, exact?: boolean): boolean {
  if (exact) return pathname === url;
  return pathname === url || pathname.startsWith(`${url}/`);
}

/**
 * The entries of a pro screen show only when the build carries its console
 * module and, for billing, the session holds `billing.enforced`
 * (`src/pro-console/`): solo, no nav entry points at a route that is not there.
 */
export function useVisibleSettingsGroups<G extends { items: { url: string }[] }>(groups: G[]): G[] {
  const billing = useProFeature("billing") !== undefined;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.url !== "/settings/billing" || billing) }))
    .filter((group) => group.items.length > 0);
}
