/**
 * The contract between the open core and an optional pro plug-in. The core
 * never imports a plug-in statically: it receives module specifiers, loads
 * them with `import()` and keeps only the plug-ins that pass
 * `loadProPlugins`. Without any plug-in the core builds, tests and runs
 * unchanged.
 *
 * Everything here is framework-free on purpose: the API, the worker and the
 * console each adapt the parts they understand (Hono routes, worker jobs,
 * lazy console routes) in their own composition root.
 */

/** Bumped when a field below changes meaning. A plug-in declares the version it was built for. */
export const PLUGIN_API_VERSION = 1 as const;

/** Lower-case id, also the prefix of the plug-in's migrations and entitlements. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** `<plugin id>.<feature>`, for example `billing.enforced`. */
export const ENTITLEMENT_RE = /^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9_]{0,63}$/;

/** Absolute paths a plug-in may redirect: lower-case segments, no trailing slash. */
export const ALIAS_PATH_RE = /^(\/[a-z0-9][a-z0-9_-]*)+$/;

/**
 * Compatibility aliases: an old URL that is already out there (a link in an
 * email, a bookmarked tab). The core keeps no alias of its own; a plug-in
 * that owns the old path declares it here, and the core applies it
 * generically: a request under `from` gets a 308 to the same rest under
 * `to`, query kept, before any session check; never over a core route, and
 * never touching the session root (`SESSION_ALIAS_ROOT`).
 */
export type CompatAlias = {
  readonly from: string;
  readonly to: string;
  /** Paths only: redirect `from` itself and nothing below it. */
  readonly exact?: boolean;
};

/** The root of the session routes: no path alias may touch it. */
export const SESSION_ALIAS_ROOT = "/api/auth";

export type CompatAliases = {
  readonly paths?: readonly CompatAlias[];
};

export type ProPluginManifest = {
  readonly id: string;
  /** The plug-in's own semver. */
  readonly version: string;
  /** The `PLUGIN_API_VERSION` it was built against. */
  readonly pluginApi: number;
  /** Entitlements this plug-in can grant; the plan decides which an organization gets. */
  readonly entitlements: readonly string[];
  /** Deployment variables read under their deployed name (`PluginEnvVariable`); none by default. */
  readonly env?: readonly PluginEnvVariable[];
};

/**
 * A deployment variable a plug-in reads under its own deployed name instead
 * of `OPENEDBOT_PLUGIN_<ID>__<KEY>`: for a name that is already a deploy contract
 * (secret manager, a provider's dashboard), so that moving code into a
 * plug-in renames nothing on the deploy side. The core never reads it: it
 * hands the plug-in the declared names that are set (`HookContext.env`),
 * and the API refuses to start in production while a loaded plug-in misses
 * one marked `requiredInProduction`. A name the core itself declares (its
 * environment schema), an `OPENEDBOT_*` name or a duplicate is refused by the
 * loader: a plug-in never reads the core's variables this way.
 */
export type PluginEnvVariable = {
  readonly name: string;
  /** Production: the API does not start without a non-empty value while the plug-in is loaded. */
  readonly requiredInProduction?: boolean;
};

/** Upper-case words joined by single `_`, at least two words. */
export const PLUGIN_ENV_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** At most this many declared variables per plug-in. */
export const PLUGIN_ENV_MAX = 16;

/** A group of API routes the core mounts under `/api/pro/<plugin id><prefix>`. */
export type ApiMount<Router = unknown, Context = unknown> = {
  /** Starts with `/`; never shadows a core route because of the `/api/pro/<id>` root. */
  readonly prefix: string;
  /** `session`: behind the core session middleware; `public`: before it (webhooks, invitations). */
  readonly access: "public" | "session";
  /** Organization entitlement checked by the core before every request; omit for public mounts only. */
  readonly entitlement?: string;
  readonly build: (context: Context) => Router;
};

/** SQL migrations shipped by the plug-in, applied after the core ones, recorded as `<id>:<file>`. */
export type MigrationSet = {
  /** Absolute directory of `NNNN_name.sql` files. */
  readonly directory: string;
};

/**
 * What the core hands every hook as its last argument: the plug-in's own
 * configuration (`OPENEDBOT_PLUGIN_<ID>__<KEY>`, indexed by KEY), never the whole
 * environment. Optional so that hooks written before it keep their shape.
 */
export type HookContext = {
  readonly config: Readonly<Record<string, string>>;
  /**
   * The plug-in's declared deployment variables (`manifest.env`) that are
   * set, by their full name; absent when the manifest declares none.
   */
  readonly env?: Readonly<Record<string, string>>;
};

/** Narrow, optional extension points. The core calls them; a missing hook is a no-op. */
export type CoreHooks = {
  /** Extra entitlements for an organization, on top of the plan. */
  readonly entitlementsFor?: (organizationId: string, context?: HookContext) => Promise<readonly string[]>;
  /** Called once an organization is created; must not throw (errors are logged). */
  readonly onOrganizationCreated?: (organizationId: string, context?: HookContext) => Promise<void>;
  /**
   * Called by the worker INSIDE the tenant purge transaction (a Bun
   * `TransactionSQL`), just before the organization row is deleted: remove
   * (or, for rows kept by law, archive) what the plug-in keeps for it. A
   * throw, or no answer within the core timeout, fails the purge, which is
   * retried later.
   */
  readonly onTenantDeleting?: (
    tx: unknown,
    event: { readonly organizationId: string; readonly reason: string },
    context?: HookContext,
  ) => Promise<void>;  /**
   * Billing only (open-core step 8d; the loader refuses it from any other
   * id). Called by the API INSIDE the organization-creation transaction (a
   * Bun `TransactionSQL`), right after the organization and its owner
   * membership are written: the place where the welcome subscription is
   * written. A throw, or no answer within the core timeout, rolls the
   * creation back: an organization never exists without what billing
   * wanted to attach to it.
   */
  readonly onOrganizationCreating?: (
    tx: unknown,
    event: OrganizationCreatingEvent,
    context?: HookContext,
  ) => Promise<void>;
};

/** What `onOrganizationCreating` is told about the organization being created. */
export type OrganizationCreatingEvent = {
  readonly organizationId: string;
  /** `billing.enforced`, as resolved by the API at boot. */
  readonly billingEnforced: boolean;
  readonly environment: "development" | "test" | "production";
};

/** `[a-z][a-z0-9-]{1,39}`, unique within its plug-in. */
export const WORKER_JOB_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
/** A plug-in job never runs more often than once a minute. */
export const WORKER_JOB_MIN_EVERY_MS = 60_000;

/**
 * A recurring pass the worker schedules for a plug-in, single-flight like
 * the core maintenance jobs, logged as `pro:<plugin id>:<name>`.
 */
export type WorkerJob = {
  readonly name: string;
  /** Minimum gap between two pass starts, at least `WORKER_JOB_MIN_EVERY_MS`. */
  readonly everyMs: number;
  /**
   * Read once at worker boot with the plug-in's configuration; `false` (or a
   * throw) leaves the job unscheduled and logged. Omitted: always enabled.
   */
  readonly enabled?: (context: HookContext) => boolean;
  /**
   * One pass. `db` is the worker pool (a Bun `SQL`, role `openedbot_worker`); the
   * pass must stop early when `signal` aborts (worker shutdown). A throw is
   * logged and the next pass runs on schedule.
   */
  readonly run: (db: unknown, context: HookContext & { readonly signal: AbortSignal }) => Promise<void>;
};

/**
 * The entitlement that hands an organization's permission rules to the
 * `permissions` plug-in (PERM2, US-PERM2 v2). Without it, or without the
 * plug-in, the gate reads the core rules: the decisions are the same as solo.
 */
export const PERMISSIONS_V2_ENTITLEMENT = "permissions.v2" as const;

/** The only plug-in id whose `permissionRules` and `approvalReviewer` the core reads. */
export const PERMISSIONS_PLUGIN_ID = "permissions" as const;

/** The gate a rule read is for: only its kind and tool, never its arguments. */
export type PermissionRuleQuery = {
  readonly organizationId: string;
  readonly botId: string;
  readonly gateKind: "plugin_tool" | "terminal_danger" | "unknown";
  readonly toolKey: string | null;
};

/** What the pipeline needs beyond the bot's mode and revision, which the core reads itself. */
export type PermissionRules = {
  /** PERM2-8; no stored policy is no ceiling, no enforced review and no blocklist. */
  readonly organizationPolicy: {
    readonly ceiling: "manual" | "auto" | "bypass" | null;
    readonly enforceReview: boolean;
    readonly commandBlocklist: readonly string[];
  };
  /** PERM2-5: the stored policy of the gate's tool, `null` when it follows the mode. */
  readonly toolPolicy: string | null;
  /** PERM2-4: the active grant for the gate's tool, and the runtime terminal switch. */
  readonly grants: { readonly grantId: string | null; readonly terminalAlways: boolean };
};

/**
 * The rules a `v2` gate is decided under. The core keeps the gate, its locks
 * and the pure pipeline (`permission-gate.ts`, `permission-decision.ts`);
 * the source only reads. `tx` is the run's transaction (a Bun
 * `TransactionSQL`) holding the organization and bot locks `for share`: a
 * source must read inside it, and leave `app.organization_id` as it found it.
 */
export type PermissionRuleSource = {
  readonly read: (tx: unknown, query: PermissionRuleQuery) => Promise<PermissionRules>;
  /**
   * PERM2-9: whether nobody waits for a gate of this workflow ("Never wait").
   * `tx` holds the run, then the workflow, `for update`. Absent: the core's.
   * (The natural-language rules are not read through this port: the core
   * holds none; the reviewer of `approvalReviewer` reads its own.)
   */
  readonly unattended?: (tx: unknown, query: UnattendedQuery) => Promise<boolean>;
};

/** The workflow a gate's run belongs to. */
export type UnattendedQuery = { readonly organizationId: string; readonly workflowId: string };

/** A reviewer pass never runs more often than this. */
export const REVIEWER_PASS_MIN_EVERY_MS = 250;

/** What the worker hands a reviewer pass. */
export type ReviewerPassContext = HookContext & {
  /** The worker's shutdown: a pass stops early, a review in flight hands its gate to a person. */
  readonly signal: AbortSignal;
  /** Hands work started by the pass to the worker's drain: the database stays open until it settles. */
  readonly track: (work: Promise<void>) => void;
  /** What the worker lends: `{ config }`, its configuration (runtime clients, keyring). */
  readonly host: unknown;
};

/** A recurring pass of the reviewer, single-flight, logged as `pro:permissions:<name>`. */
export type ReviewerPass = {
  /** `WORKER_JOB_NAME_RE`, unique within the reviewer. */
  readonly name: string;
  /** At least `REVIEWER_PASS_MIN_EVERY_MS`. */
  readonly everyMs: number;
  /** `db` is the worker pool (a Bun `SQL`, role `openedbot_worker`). A throw is logged; the next pass runs on schedule. */
  readonly run: (db: unknown, context: ReviewerPassContext) => Promise<void>;
};

/**
 * The automatic approval reviewer (only from the plug-in `permissions`): a
 * model judges the gates the pipeline sends to review (`auto` mode,
 * enforced review). The core keeps the pipeline (`permission-decision.ts`),
 * the gate, its states and the human answer.
 *
 * The core's default, without it, is no reviewer: `ready` is false for
 * every organization, so `auto` acts as `manual`, a new bot starts in
 * `manual`, no gate is born `reviewing`, and the worker hands any gate left
 * `reviewing` to a person (or refuses it on a "Never wait" workflow).
 */
export type ApprovalReviewerPort = {
  /**
   * Whether this organization's gates can be reviewed now (its review
   * profile proven, for instance). Called inside the caller's transaction (a
   * Bun `TransactionSQL`, bound to the organization), within a savepoint; it
   * must leave `app.organization_id` as it found it. `false` or a throw:
   * `auto` acts as `manual` for this decision.
   */
  readonly ready: (tx: unknown, organizationId: string) => Promise<boolean>;
  /** The worker passes that claim and judge the gates under review, and keep the review profiles proven. */
  readonly passes: readonly ReviewerPass[];
};

/** A payment webhook path: `/api/<segment>/<segment>[/…]`, lower case, no parameter. */
export const PAYMENT_WEBHOOK_PATH_RE = /^\/api(\/[a-z0-9][a-z0-9_-]*){2,}$/;
/** Roots a payment webhook path may not enter: the plug-in mounts, the session routes, the hook ingress. */
export const PAYMENT_WEBHOOK_RESERVED_ROOTS = ["/api/pro", "/api/auth", "/api/hooks"] as const;

/** The only plug-in id whose `billing` hooks the core reads. */
export const BILLING_PLUGIN_ID = "billing" as const;

/**
 * What the core lends the plug-in `billing` on its webhook call (step 8d):
 * the hook context plus `host`, the API's `{ db, config }` (the plug-in
 * types it structurally; the core never reads it back).
 */
export type BillingHookContext = HookContext & { readonly host?: unknown };

/**
 * The members the core calls on a subscription port (`SubscriptionPort` of
 * `@openedbot/platform-db`, kept structural here: this package does not depend on
 * the database). The loader checks they are functions.
 */
export const SUBSCRIPTION_PORT_MEMBERS = ["status", "read", "readForUpdate", "admission"] as const;

/**
 * Billing (only from the plug-in `billing`, steps 8c-8d, 11.4, 11.5).
 *
 * - `webhookPath` and `webhook`: the plug-in names the path of its payment
 *   webhook (the deployed contract with its provider, which the core never
 *   names); the core mounts `POST <webhookPath>` before the session check
 *   and exempts it from the session (the provider signs the request, it
 *   carries no session), hands the raw request over and returns the
 *   plug-in's response unchanged, checking no signature itself. A throw is
 *   the core's 500. Billing loaded but refused (role guard): 503
 *   `PAYMENT_WEBHOOK_UNAVAILABLE` at that path. Solo: the core mounts
 *   nothing there, the path is unknown like any other.
 * - `subscriptions`: the `SubscriptionPort` identity, the run queue and the
 *   routines read; without it, `NO_SUBSCRIPTIONS` (no limit, no paywall).
 */
export type BillingHooks = {
  /**
   * Absolute, static, under `/api/` with at least two more segments
   * (`PAYMENT_WEBHOOK_PATH_RE`), outside `PAYMENT_WEBHOOK_RESERVED_ROOTS`;
   * the API refuses to start when a core route answers it too.
   */
  readonly webhookPath: string;
  readonly webhook: (request: Request, context?: BillingHookContext) => Promise<Response>;
  readonly subscriptions?: { readonly [member in (typeof SUBSCRIPTION_PORT_MEMBERS)[number]]: (...args: never[]) => unknown };
};

/** The only plug-in id whose `auditArchive` the core reads. */
export const AUDIT_PLUGIN_ID = "audit" as const;

/** What the core hands an audit archive: one anchor received from a connector, or one signed verdict. */
export type AuditArchiveRecord = {
  readonly organizationId: string;
  readonly runtimeId: string;
  readonly kind: "runtime_anchor" | "audit_verdict";
  /** `audit/<runtime id>/anchors/<writeSeq, 12 digits>.json` or `audit/<runtime id>/verdicts/<verdict id>.json`. */
  readonly objectKey: string;
  /** The canonical JSON of the record: the very bytes the core's local chain digests. */
  readonly bytes: Uint8Array;
};

/** A deposit attempted inside a business transaction that then rolled back. */
export type AuditArchiveAttempt = {
  readonly organizationId: string;
  readonly runtimeId: string;
  readonly kind: AuditArchiveRecord["kind"];
  readonly objectKey: string;
  readonly anchorId: string;
  /** `confirmed`: `put` answered. `unknown`: it failed or timed out, the object may exist. */
  readonly written: "confirmed" | "unknown";
};

/** At most this many characters in `AuditArchivePort.id` (it is stored with orphan marks). */
export const AUDIT_ARCHIVE_ID_MAX = 128;

/**
 * External archiving of the creation audit (only from the plug-in `audit`).
 * The core's default, without it, is PostgreSQL only: the local hash chain
 * (`audit_chain`) is the core's anchoring, every verification says
 * `worm: disabled`, and nothing external is required in any environment.
 *
 * With it, every anchor and every verdict the core chains is ALSO handed to
 * `put`, inside the same business transaction, after the local chain. A
 * throw (or no answer within the core timeout) blocks the write for an
 * organization holding `audit.anchor`, and is only logged
 * (`worm_write_failed`) otherwise. The API and the link gateway both read it.
 */
export type AuditArchivePort = {
  /** For logs and orphan marks; 1 to `AUDIT_ARCHIVE_ID_MAX` characters. */
  readonly id: string;
  /**
   * Deposits the bytes under the key once and never rewrites them;
   * idempotent per key (a link already chained is handed over again on
   * replay, with its original bytes). `tx` is the business transaction (a
   * Bun `TransactionSQL`). Throws on failure.
   */
  readonly put: (tx: unknown, record: AuditArchiveRecord) => Promise<void>;
  /** The archived bytes, or `null` when never deposited: read when an export is verified. */
  readonly get: (objectKey: string) => Promise<Uint8Array | null>;
  /**
   * Called in a transaction of its own under the caller's context (tenant
   * or link credential) when a business transaction that attempted deposits
   * rolled back: the objects may exist with no chain link pointing to them.
   * Must delete nothing. Absent: nothing is marked.
   */
  readonly orphaned?: (tx: unknown, attempts: readonly AuditArchiveAttempt[], reason: string) => Promise<void>;
};

export type ProPlugin<Router = unknown, Context = unknown> = {
  readonly manifest: ProPluginManifest;
  readonly api?: readonly ApiMount<Router, Context>[];
  readonly migrations?: MigrationSet;
  /** Module specifier of the console bundle exposing lazy routes; resolved by the console build. */
  readonly console?: { readonly module: string };
  readonly hooks?: CoreHooks;
  /** Recurring worker passes; the API ignores them. */
  readonly jobs?: readonly WorkerJob[];
  /**
   * Only read from the plug-in `permissions`, which must declare
   * `permissions.v2`; used for an organization its `entitlementsFor` grants
   * `permissions.v2` to, the core rules otherwise.
   */
  readonly permissionRules?: PermissionRuleSource;
  /** Only read from the plug-in `permissions` (`ApprovalReviewerPort`). */
  readonly approvalReviewer?: ApprovalReviewerPort;
  /** Only read from the plug-in `billing`. */
  readonly billing?: BillingHooks;
  /** Only read from the plug-in `audit` (`AuditArchivePort`). */
  readonly auditArchive?: AuditArchivePort;
  /** Old names this plug-in keeps answering (`CompatAliases`). */
  readonly aliases?: CompatAliases;
};
