/**
 * Facade for the route files: the product switches are read in the core
 * (`@openedbot/identity/application/product-features`) and gated by its
 * entitlements (`@openedbot/identity/application/entitlements`).
 */
export * from "@openedbot/identity/application/product-features";
export { sessionEntitlements } from "@openedbot/identity/application/entitlements";
