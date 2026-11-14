export const TRANSACTIONAL_EMAIL_KINDS = [
  "organization_member_invitation",
  "email_login_code",
  "provider_quota_reached",
  "account_purge_completed",
  "account_closure_notice",
  "runtime_link_down",
  "runtime_link_restored",
  "runtime_connector_outdated",
  "workflow_approval",
  "workflow_completed",
  "workflow_failed",
] as const;

export type TransactionalEmailKind = (typeof TRANSACTIONAL_EMAIL_KINDS)[number];

export function isTransactionalEmailKind(value: unknown): value is TransactionalEmailKind {
  return typeof value === "string"
    && (TRANSACTIONAL_EMAIL_KINDS as readonly string[]).includes(value);
}

export const TRANSACTIONAL_EMAIL_LOCALES = ["fr", "en"] as const;

export type TransactionalEmailLocale = (typeof TRANSACTIONAL_EMAIL_LOCALES)[number];

/** An absent or unknown language falls back to French, the product's default language. */
export function transactionalEmailLocale(value: unknown): TransactionalEmailLocale {
  return value === "en" ? "en" : "fr";
}
