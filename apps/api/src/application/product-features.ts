/**
 * Façade for the route files: the product switches are read in the core
 * (`@openedbot/identity/application/product-features`) and gated by its
 * entitlements (`@openedbot/identity/application/entitlements`). Nothing here
 * imports `staff`.
 */
export * from "@openedbot/identity/application/product-features";
export {
  fleetBillingEnabled,
  fleetWorkspacesEnabled,
  sessionEntitlements,
  waitlistEnabled,
  type ProductFeatureSource,
} from "@openedbot/identity/application/entitlements";
