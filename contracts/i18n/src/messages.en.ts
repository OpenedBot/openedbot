/**
 * English dictionary : same shape as `messages.fr.ts`, key for key.
 *
 * A key added here without its French counterpart (or vice versa) fails the
 * completeness test in `index.test.ts`. See `docs/cloud/DEVELOPMENT.md`.
 */
import { changePassword, legal, login, memberInvitation } from "./messages/en/auth";
import { botCloneDialog, botContextMenu, botManage, botsTable, newBotDialog, voicePanel } from "./messages/en/bot-lifecycle";
import { botCapabilities, botMemory, botRoutinesDialog, botSettingsDialog, computerPanel, settingProposal } from "./messages/en/bots";
import { agentActivity, attachmentCanvas, composer, gateCard, groups, mobileComposer, planCard, workflowOverview } from "./messages/en/composer";
import { connectorsPage, connectorsSettings, mcpCatalog, webhookPanel } from "./messages/en/connectors";
import { decisions, inbox, orgPermissionPolicy, settingsPolicies } from "./messages/en/control";
import { apiClient, common, errorState, eventParts, face, format, notFound, relativeTime, toolLabels, units } from "./messages/en/core";
import { modelsSettings } from "./messages/en/models";
import { onboarding, tailscaleGuide } from "./messages/en/onboarding";
import { cloudRuntimeSettings, connectorUpgrade, providerIncidents, providerLimits, runtimeAlerts, runtimeDirect, runtimeHealth, runtimeOffline, runtimeRail } from "./messages/en/runtime";
import { botHostCleanup, botProfileProvision, botProfileRepair, profileImport } from "./messages/en/runtime-profiles";
import { mobileSettingsHints, mobileSettingsRuntimes, operatorSettingsDialog, pushNotifications, settings, settingsAccount, settingsArchives, settingsDeveloper, settingsNotifications, settingsProfile, settingsSecurity, settingsSidebar } from "./messages/en/settings";
import { appSidebar, boardui, commandPalette, compactShell, featureLab, mobileShell, modeLanding, navUser, overviewPlaceholder, pwaInstall } from "./messages/en/shell";
import { conversation, threadActivity, threadContext, threadFind, threadScreen, threadTimeline, threadTurnRail } from "./messages/en/thread";
import { waitlist } from "./messages/en/waitlist";
import { chartArea, chartTokens, dashboardMetrics, fleet, fleetClients, sectionCards, support } from "./messages/en/workspace";

export const en = {
  fleet,
  tailscaleGuide,
  runtimeDirect,
  relativeTime,
  units,
  common,
  pwaInstall,
  providerLimits,
  settings,
  overviewPlaceholder,
  modeLanding,
  settingsSidebar,
  errorState,
  notFound,
  connectorsSettings,
  botSettingsDialog,
  operatorSettingsDialog,
  webhookPanel,
  botProfileRepair,
  botProfileProvision,
  mcpCatalog,
  connectorsPage,
  botCapabilities,
  computerPanel,
  voicePanel,
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
  waitlist,
  login,
  runtimeHealth,
  runtimeRail,
  connectorUpgrade,
  providerIncidents,
  modelsSettings,
  decisions,
  newBotDialog,
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
} as const;
