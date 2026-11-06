/**
 * Dictionnaire français : langue de référence du dépôt.
 *
 * Toute chaîne ici est la formulation existante, reprise mot pour mot depuis
 * l'écran qui la portait avant extraction : voir `docs/cloud/DEVELOPMENT.md`. Le test de
 * complétude (`index.test.ts`) échoue si une clé manque côté anglais, ou si
 * un `{paramètre}` diffère entre les deux fichiers.
 */
import { changePassword, legal, login, memberInvitation } from "./messages/fr/auth";
import { botCloneDialog, botContextMenu, botManage, botsTable, homeNewBot, newBotDialog } from "./messages/fr/bot-lifecycle";
import { botCapabilities, botMemory, botRoutinesDialog, botSettingsDialog, settingProposal } from "./messages/fr/bots";
import { agentActivity, attachmentCanvas, composer, gateCard, groups, mobileComposer, planCard, workflowOverview } from "./messages/fr/composer";
import { connectorsPage, connectorsSettings, mcpCatalog, webhookPanel } from "./messages/fr/connectors";
import { decisions, inbox, orgPermissionPolicy, settingsPolicies } from "./messages/fr/control";
import { apiClient, common, errorState, eventParts, face, format, notFound, relativeTime, toolLabels, units } from "./messages/fr/core";
import { modelsSettings } from "./messages/fr/models";
import { onboarding, tailscaleGuide } from "./messages/fr/onboarding";
import { cloudRuntimeSettings, connectorUpgrade, providerIncidents, providerLimits, runtimeAlerts, runtimeDirect, runtimeHealth, runtimeOffline, runtimeRail, railQuotas } from "./messages/fr/runtime";
import { botHostCleanup, botProfileProvision, botProfileRepair, profileImport } from "./messages/fr/runtime-profiles";
import { mobileSettingsHints, mobileSettingsRuntimes, pushNotifications, settings, settingsAccount, settingsArchives, settingsDeveloper, settingsNotifications, settingsProfile, settingsSecurity, settingsSidebar } from "./messages/fr/settings";
import { appSidebar, boardui, clientUpdate, commandPalette, compactShell, desktopNotch, desktopUpdate, featureLab, mobileShell, modeLanding, navUser, overviewPlaceholder } from "./messages/fr/shell";
import { conversation, threadActivity, threadContext, threadFind, threadScreen, threadTimeline, threadTurnRail } from "./messages/fr/thread";
import { chartArea, chartTokens, dashboardMetrics, fleet, fleetClients, sectionCards, support } from "./messages/fr/workspace";

export const fr = {
  fleet,
  tailscaleGuide,
  runtimeDirect,
  relativeTime,
  units,
  common,
  providerLimits,
  settings,
  overviewPlaceholder,
  modeLanding,
  settingsSidebar,
  errorState,
  notFound,
  connectorsSettings,
  botSettingsDialog,
  webhookPanel,
  botProfileRepair,
  botProfileProvision,
  mcpCatalog,
  connectorsPage,
  botCapabilities,
  botMemory,
  threadContext,
  workflowOverview,
  agentActivity,
  botRoutinesDialog,
  settingsPolicies,
  orgPermissionPolicy,
  runtimeAlerts,
  settingsNotifications,
  pushNotifications,
  memberInvitation,
  fleetClients,
  settingsAccount,
  settingsProfile,
  settingsDeveloper,
  settingsSecurity,
  mobileSettingsHints,
  threadScreen,
  mobileComposer,
  eventParts,
  toolLabels,
  mobileSettingsRuntimes,
  conversation,
  runtimeOffline,
  featureLab,
  settingsArchives,
  settingProposal,
  gateCard,
  threadActivity,
  threadFind,
  threadTurnRail,
  botCloneDialog,
  composer,
  attachmentCanvas,
  threadTimeline,
  appSidebar,
  commandPalette,
  navUser,
  botsTable,
  sectionCards,
  dashboardMetrics,
  chartArea,
  chartTokens,
  botContextMenu,
  botHostCleanup,
  groups,
  apiClient,
  cloudRuntimeSettings,
  profileImport,
  onboarding,
  legal,
  login,
  runtimeHealth,
  runtimeRail,
  railQuotas,
  connectorUpgrade,
  providerIncidents,
  modelsSettings,
  decisions,
  newBotDialog,
  homeNewBot,
  botManage,
  face,
  format,
  inbox,
  mobileShell,
  changePassword,
  support,
  boardui,
  planCard,
  compactShell,
  clientUpdate,
  desktopUpdate,
  desktopNotch,
} as const;
