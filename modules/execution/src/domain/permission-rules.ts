/**
 * The rules a `v2` gate is decided under, as the gate reads them through a
 * `PermissionRuleSource` (the port `PermissionRuleSource` of
 * `@openedbot/platform-plugins`, same shape; `apps/worker` checks they stay equal).
 * The core source reads today's tables (`core-permission-rules.ts`); the
 * plug-in `permissions` may bring its own for the organizations holding
 * `permissions.v2`. The same port carries the reviewer's rules (PERM2-6) and
 * a workflow's "Never wait" (PERM2-9): nothing in the pipeline reads them
 * around it.
 */
import type { GateKind } from "./gate-identity";
import type { PermissionCeiling } from "./permission-decision";

export type PermissionRuleQuery = {
  readonly organizationId: string;
  readonly botId: string;
  readonly gateKind: GateKind;
  readonly toolKey: string | null;
};

/** PERM2-8: the organization's policy; no row is no ceiling and no blocklist. */
export type OrganizationPermissionPolicy = {
  readonly ceiling: PermissionCeiling | null;
  readonly enforceReview: boolean;
  readonly commandBlocklist: readonly string[];
};

/** PERM2-4. `grantId`: the active grant itself, recorded with a decision it answers (PERM2-11). */
export type PermissionGrants = { readonly grantId: string | null; readonly terminalAlways: boolean };

export type PermissionRules = {
  readonly organizationPolicy: OrganizationPermissionPolicy;
  /** PERM2-5: the stored policy of the gate's tool, `null` when it follows the mode. */
  readonly toolPolicy: string | null;
  readonly grants: PermissionGrants;
};

/** PERM2-6: the reviewer's rules for one bot, raw; `effectiveReviewRules` filters and cleans them. */
export type ReviewRuleQuery = { readonly organizationId: string; readonly botId: string };
export type ReviewRules = {
  readonly rulesMode: string | null;
  readonly rules: readonly { readonly scope: "bot" | "organization"; readonly kind: string; readonly text: string }[];
};
/** PERM2-9: the workflow whose "Never wait" a gate is decided under. */
export type UnattendedQuery = { readonly organizationId: string; readonly workflowId: string };

export type PermissionRuleSource = {
  /** `tx` is the run's transaction, holding the organization and bot locks `for share`. */
  readonly read: (tx: unknown, query: PermissionRuleQuery) => Promise<PermissionRules>;
  /** `tx` is the reviewer's transaction. Absent: the core's. */
  readonly reviewRules?: (tx: unknown, query: ReviewRuleQuery) => Promise<ReviewRules>;
  /** `tx` holds the run, then the workflow, `for update`. Absent: the core's. */
  readonly unattended?: (tx: unknown, query: UnattendedQuery) => Promise<boolean>;
};

/** What the core reads through: every member present, a plug-in's missing ones taken from the core. */
export type ResolvedPermissionRuleSource = Required<PermissionRuleSource>;

export const NO_ORGANIZATION_POLICY: OrganizationPermissionPolicy = { ceiling: null, enforceReview: false, commandBlocklist: [] };
export const NO_GRANTS: PermissionGrants = { grantId: null, terminalAlways: false };
