import type { TransactionalEmailKind } from "@openedbot/contracts-api";

/**
 * Valeurs inventées pour les aperçus, jamais une capture d'un compte réel.
 * Elles sont partagées par le script hors ligne et l'atelier staff.
 */
export const TRANSACTIONAL_EMAIL_SAMPLE_DATA: Record<
  TransactionalEmailKind,
  Record<string, unknown>
> = {
  agency_client_invitation: { agencyName: "Acme", invitationUrl: "https://openedbot.app/invite/fleet/example" },
  agency_client_response: { email: "client@example.com", status: "accepted" },
  organization_member_invitation: {
    organizationName: "Acme",
    role: "member",
    invitationUrl: "https://openedbot.app/invite/member/example",
  },
  waitlist_confirmation: {
    webAppUrl: "https://openedbot.app",
  },
  waitlist_access_granted: {
    // L'aperçu montre la forme NOMINALE : depuis le 2026-09-10, une ouverture
    // d'accès porte un mot de passe temporaire. Un compte qui n'entre que par
    // Google reçoit la même page sans ces deux lignes.
    email: "personne@example.test",
    temporaryPassword: "Mjtd-6kpr-9wxb-4nqh",
    webAppUrl: "https://openedbot.app",
  },
  waitlist_access_tier_changed: {
    tier: "beta",
    webAppUrl: "https://openedbot.app",
  },
  waitlist_access_revoked: {
    webAppUrl: "https://openedbot.app",
  },
  staff_account_created: {
    email: "nouvelle.personne@example.test",
    temporaryPassword: "Kfrt-9xmv-2dpq-7bhn",
    webAppUrl: "https://openedbot.app",
  },
  staff_password_reset: {
    email: "personne@example.test",
    temporaryPassword: "Rkvt-4bnq-8xmd-3phj",
    webAppUrl: "https://openedbot.app",
  },
  email_login_code: {
    code: "482913",
    expiresInMinutes: "10",
  },
  staff_login_code: {
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
  support_new_conversation: {
    conversationId: "8f14e45f-ceea-467a-9d0b-1c3a2f5b7d91",
    guestEmail: "visiteur@example.test",
    conversationUrl: "https://backoffice.example.test/support/8f14e45f-ceea-467a-9d0b-1c3a2f5b7d91",
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
  yolo_audit_quarantined: {
    runtimeName: "MacBook atelier",
    reason: "prev_mismatch",
    fromSeq: 41,
    toSeq: 48,
    receivedAt: "2026-11-02T09:14:00.000Z",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
    webAppUrl: "https://openedbot.app",
  },
  yolo_solo_default_ended: {
    organizationName: "Atelier",
    reason: "members",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
    webAppUrl: "https://openedbot.app",
  },
};
