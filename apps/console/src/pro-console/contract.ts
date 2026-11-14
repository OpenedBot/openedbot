/**
 * What a pro console module gives the console (open-core step 9).
 *
 * The console builds its pro screens from `virtual:openedbot-pro-console`
 * (`vite-pro-console.ts`): solo, the list is empty and no billing or
 * permission-rules screen enters the bundle; pro, each entry of
 * `OPENEDBOT_CONSOLE_PLUGINS` is one of these modules. A feature is shown only when its
 * module is present AND the session holds its entitlement (`/api/auth/me`).
 *
 * The slot types are written out here (open-core step 11): the screens live
 * in the external plugin repo, and the core reads them only through this
 * contract and `slots.tsx`.
 */
import type { ComponentType } from "react";
import type { BotDto } from "@openedbot/contracts-api";

/** The entitlement each feature needs (`modules/identity/src/application/entitlements.ts`). */
export const PRO_CONSOLE_ENTITLEMENTS = {
  billing: "billing.enforced",
  permissions: "permissions.rules",
} as const;

export type ProConsoleFeature = keyof typeof PRO_CONSOLE_ENTITLEMENTS;

/** The billing screen (dev settings), from the pro plug-in `pro-billing/console` since step 8d. */
export type BillingConsole = {
  entitlement: typeof PRO_CONSOLE_ENTITLEMENTS.billing;
  BillingSettings: ComponentType;
};

/** Permission rules (pro-permissions): one card per bot, one per organization. */
export type PermissionsConsole = {
  entitlement: typeof PRO_CONSOLE_ENTITLEMENTS.permissions;
  BotPermissionRules: ComponentType<{ bot: BotDto }>;
  OrganizationPermissionRulesSettings: ComponentType;
};

export type ProConsoleModule = {
  /** The plug-in id, for diagnostics. */
  id: string;
  billing?: BillingConsole;
  permissions?: PermissionsConsole;
};

export type ProConsoleFeatures = {
  billing?: BillingConsole;
  permissions?: PermissionsConsole;
};
