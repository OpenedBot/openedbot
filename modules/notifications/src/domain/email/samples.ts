import type { TransactionalEmailKind } from "@openedbot/contracts-api";

/**
 * Valeurs inventées pour les aperçus, jamais une capture d'un compte réel.
 * Elles servent au script hors ligne des aperçus.
 */
export const TRANSACTIONAL_EMAIL_SAMPLE_DATA: Record<
  TransactionalEmailKind,
  Record<string, unknown>
> = {
  workflow_approval: { botName: "MVP bot", conversationUrl: "https://openedbot.app/bot/example" },
  workflow_completed: { botName: "MVP bot", conversationUrl: "https://openedbot.app/bot/example" },
  workflow_failed: { botName: "MVP bot", conversationUrl: "https://openedbot.app/bot/example" },
  organization_member_invitation: {
    organizationName: "Acme",
    role: "member",
    invitationUrl: "https://openedbot.app/invite/member/example",
  },
  email_login_code: {
    code: "482913",
    expiresInMinutes: "10",
  },
  provider_quota_reached: {
    provider: "anthropic",
    kind: "quota",
    occurredAt: "2026-09-08T14:32:00.000Z",
    fallback: "opencode-free / nemotron",
    settingsUrl: "https://openedbot.app/settings/models",
    webAppUrl: "https://openedbot.app",
  },
  account_purge_completed: {
    purgedAt: "2026-09-08",
    webAppUrl: "https://openedbot.app",
  },
  account_closure_notice: {
    displayName: "Camille Lefèvre",
    webAppUrl: "https://openedbot.app",
  },
  runtime_link_down: {
    runtimeName: "VPS production",
    reason: "Aucun signe de vie du lien depuis 45 s.",
    downSince: "2026-09-14T11:02:00.000Z",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
    webAppUrl: "https://openedbot.app",
  },
  runtime_link_restored: {
    runtimeName: "VPS production",
    downSince: "2026-09-14T11:02:00.000Z",
    restoredAt: "2026-09-14T11:31:00.000Z",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
    webAppUrl: "https://openedbot.app",
  },
  runtime_connector_outdated: {
    runtimeName: "VPS production",
    installedVersion: "v0.5.3",
    targetVersion: "v0.5.7",
    latestVersion: "v0.5.7",
    upgradeCommand: "sudo edge-setup upgrade --yes",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
    webAppUrl: "https://openedbot.app",
  },
};
