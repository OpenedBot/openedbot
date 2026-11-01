export const TRANSACTIONAL_EMAIL_KINDS = [
  "agency_client_invitation",
  "agency_client_response",
  "organization_member_invitation",
  "waitlist_confirmation",
  "waitlist_access_granted",
  "waitlist_access_tier_changed",
  "waitlist_access_revoked",
  "staff_account_created",
  "staff_password_reset",
  "staff_login_code",
  "email_login_code",
  "provider_quota_reached",
  "account_purge_completed",
  "account_closure_notice",
  "support_new_conversation",
  "runtime_link_down",
  "runtime_link_restored",
  "runtime_connector_outdated",
] as const;

export type TransactionalEmailKind = (typeof TRANSACTIONAL_EMAIL_KINDS)[number];

export function isTransactionalEmailKind(value: unknown): value is TransactionalEmailKind {
  return typeof value === "string"
    && (TRANSACTIONAL_EMAIL_KINDS as readonly string[]).includes(value);
}

export const TRANSACTIONAL_EMAIL_LOCALES = ["fr", "en"] as const;

export type TransactionalEmailLocale = (typeof TRANSACTIONAL_EMAIL_LOCALES)[number];

/** Une langue absente ou inconnue reprend le français, langue par défaut du produit. */
export function transactionalEmailLocale(value: unknown): TransactionalEmailLocale {
  return value === "en" ? "en" : "fr";
}
