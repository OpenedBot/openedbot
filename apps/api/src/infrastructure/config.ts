/**
 * Facade: the API configuration lives in `@openedbot/platform-config/api-config`,
 * because the link gateway (apps/link-gateway) reads it too and never
 * imports apps/api.
 */
export * from "@openedbot/platform-config/api-config";
