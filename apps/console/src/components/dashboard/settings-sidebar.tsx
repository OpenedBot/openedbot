import {
  IconActivity,
  IconArchive,
  IconBrain,
  IconCreditCard,
  IconHistory,
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
  IconUsers,
  IconBuildingStore,
} from "@tabler/icons-react";
import { SHOW_DEV_SETTINGS } from "../../lib/shell/dev-settings-ui";
import type { MessageKey } from "../../lib/i18n";
import type { FLEET_OWN_SETTINGS_PATHS } from "../../lib/workspace/workspace-location";
import { hasFleetConsole } from "../../pro-console/slots";
import { useProFeature } from "../../pro-console/registry";

/**
 * Les rubriques des réglages, source de la navigation de la modale et de la
 * page (`boardui/settings-modal.tsx`) et de l'écran mobile.
 *
 * Rangées par ce que l'on vient chercher (31-10) plutôt que par couche
 * technique : Moi (compte, apparence), l'Espace de travail (activité,
 * archives), les Bots et leur runtime (runtime, modèles, connecteurs), le
 * Contrôle (politiques, décisions, sécurité). « Importer des agents » est un
 * onglet de Runtime (sa colonne de sections), pas une rubrique : sa route
 * reste, et elle allume Runtime (`also`). Une rubrique pas encore active (Notifications) ne
 * s'affiche pas plutôt que de s'afficher grisée.
 *
 * Un dernier groupe, « Développement », rassemble TOUT ce qui ne s'affiche que
 * sous `make dev` (Facturation, Outils de dev). Avant, ces surfaces étaient
 * semées dans les groupes produit : Facturation entre Organisation et
 * Apparence, les outils d'accueil au bas de Profil : et rien ne disait à la
 * lecture qu'elles disparaîtraient du build. Un seul groupe, un seul
 * interrupteur : `SHOW_DEV_SETTINGS`.
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

type FleetOwnSettingsPath = (typeof FLEET_OWN_SETTINGS_PATHS)[number];
type FleetSettingsGroup = Omit<SettingsGroup, "items"> & {
  items: (Omit<SettingsGroupItem, "url"> & { url: FleetOwnSettingsPath })[];
};

/**
 * Le groupe dev, défini à part pour qu'il se lise d'un bloc : ce qui entre ici
 * n'existe pas en production, et rien d'autre ne doit y entrer.
 */
const SETTINGS_DEV_GROUP: SettingsGroup = {
  labelKey: "settingsSidebar.groupDev",
  items: [
    { titleKey: "settingsSidebar.billing", url: "/settings/billing", icon: IconCreditCard },
    { titleKey: "settingsSidebar.developer", url: "/settings/developer", icon: IconTerminal2 },
  ],
};

/** Structure statique : les libellés se résolvent à l'affichage via `useT()`. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    labelKey: "settingsSidebar.groupMe",
    items: [
      { titleKey: "settingsSidebar.account", url: "/settings/account", icon: IconUserCircle },
      { titleKey: "settingsSidebar.appearance", url: "/settings/appearance", icon: IconPalette },
      // App Tauri seulement : la mise à jour de l'app de bureau (constant au build).
      ...(import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" ? [{ titleKey: "settingsSidebar.updates" as const, url: "/settings/updates", icon: IconRefresh }] : []),
      // App Tauri sur Mac seulement : l'encoche (la coque dit son système avant le premier script).
      ...(import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" && globalThis.window?.__OPENEDBOT_SHELL__?.platform === "macos"
        ? [{ titleKey: "settingsSidebar.notch" as const, url: "/settings/notch", icon: IconDeviceLaptop }]
        : []),
    ],
  },
  {
    labelKey: "settingsSidebar.groupWorkspace",
    items: [
      { titleKey: "settingsSidebar.overview", url: "/settings", icon: IconActivity, exact: true },
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
 * The settings of an agency, opened from its fleet. An agency holds no bots of
 * its own: runtime, agents, connectors, models, decisions and policies belong
 * to each client workspace and are reached from that client's frame. What is
 * left is the person (appearance, account, security) and the agency team.
 */
export const FLEET_SETTINGS_GROUPS: FleetSettingsGroup[] = [
  {
    labelKey: "settingsSidebar.groupGeneral",
    items: [
      { titleKey: "settingsSidebar.appearance", url: "/settings/appearance", icon: IconPalette },
    ],
  },
  {
    labelKey: "fleet.agency",
    items: [
      { titleKey: "fleet.myTeam", url: "/settings/team", icon: IconUsers },
      { titleKey: "fleet.clientsSettings", url: "/settings/clients", icon: IconBuildingStore },
      { titleKey: "fleet.journalSettings", url: "/settings/journal", icon: IconHistory },
    ],
  },
];

/**
 * The Settings tab of a client opened by its agency. Agents, Policy and Audit
 * are tabs of the client frame already, the person's account belongs to the
 * agency side, and the development group stays with the operator's own space.
 */
const CLIENT_TAB_URLS: ReadonlySet<string> = new Set(["/settings/agents", "/settings/policies", "/settings/decisions", "/settings/account"]);
export const FLEET_CLIENT_SETTINGS_GROUPS: SettingsGroup[] = SETTINGS_GROUPS
  .filter((group) => group !== SETTINGS_DEV_GROUP)
  .map((group) => ({ ...group, items: group.items.filter((item) => !CLIENT_TAB_URLS.has(item.url)) }))
  .filter((group) => group.items.length > 0);

/**
 * `/settings` préfixe toutes les autres entrées : elle seule se compare en
 * exact. Les autres s'allument aussi sur leurs sous-chemins : un détail de
 * runtime ne doit pas éteindre « Edge ».
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
  const agency = hasFleetConsole();
  const shown = (url: string) => {
    if (url === "/settings/billing") return billing;
    if (url === "/settings/clients" || url === "/settings/journal") return agency;
    return true;
  };
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => shown(item.url)) }))
    .filter((group) => group.items.length > 0);
}
