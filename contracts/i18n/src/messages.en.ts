/**
 * English dictionary : same shape as `messages.fr.ts`, key for key.
 *
 * A key added here without its French counterpart (or vice versa) fails the
 * completeness test in `index.test.ts`. See `docs/cloud/DEVELOPMENT.md`.
 */
import { changePassword, legal, login, memberInvitation } from "./messages/en/auth";
import { botCloneDialog, botContextMenu, botManage, botsTable, homeNewBot, newBotDialog, voicePanel } from "./messages/en/bot-lifecycle";
import { botCapabilities, botMemory, botRoutinesDialog, botSettingsDialog, settingProposal } from "./messages/en/bots";
import { agentActivity, attachmentCanvas, composer, gateCard, groups, mobileComposer, planCard, workflowOverview } from "./messages/en/composer";
import { connectorsPage, connectorsSettings, mcpCatalog, webhookPanel } from "./messages/en/connectors";
import { decisions, inbox, orgPermissionPolicy, settingsPolicies } from "./messages/en/control";
import { apiClient, common, errorState, eventParts, face, format, notFound, relativeTime, toolLabels, units } from "./messages/en/core";
import { modelsSettings } from "./messages/en/models";
import { onboarding, tailscaleGuide } from "./messages/en/onboarding";
import { cloudRuntimeSettings, connectorUpgrade, providerIncidents, providerLimits, runtimeAlerts, runtimeDirect, runtimeHealth, runtimeOffline, runtimeRail } from "./messages/en/runtime";
import { botHostCleanup, botProfileProvision, botProfileRepair, profileImport } from "./messages/en/runtime-profiles";
import { mobileSettingsHints, mobileSettingsRuntimes, pushNotifications, settings, settingsAccount, settingsArchives, settingsDeveloper, settingsNotifications, settingsProfile, settingsSecurity, settingsSidebar } from "./messages/en/settings";
import { appSidebar, boardui, commandPalette, compactShell, featureLab, mobileShell, modeLanding, navUser, overviewPlaceholder } from "./messages/en/shell";
import { conversation, threadActivity, threadContext, threadFind, threadScreen, threadTimeline, threadTurnRail } from "./messages/en/thread";
import { yoloSolo } from "./messages/en/yolo-solo";
import { chartArea, chartTokens, dashboardMetrics, fleet, fleetClients, sectionCards, support } from "./messages/en/workspace";
import { yolo } from "./messages/en/yolo";

export const en = {
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
  voicePanel,
  botMemory,
  threadContext,
  workflowOverview,
  agentActivity,
  botRoutinesDialog,
  settingsPolicies,
  orgPermissionPolicy,
  runtimeAlerts,
  yoloSolo,
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
  yolo,
} as const;
