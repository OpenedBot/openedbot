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

/**
 * Capability entitlements: named by the core, because the core itself
 * changes when they are held (fleet organizations, the fleet frame of the
 * console, a session acting for a client), but brought by whichever
 * plug-in declares them; the loader accepts them from any id. Declaring one
 * also lends the plug-in the matching host (`context.host.fleet`).
 */
export const CAPABILITY_ENTITLEMENTS = {
  /** Fleet organizations and the fleet context of a session. */
  fleetWorkspaces: "fleet.workspaces",
  /** Fleet organizations subscribe on their own instead of staying outside the paywall. */
  fleetBilling: "fleet.billing",
} as const;

export function isCapabilityEntitlement(entitlement: string): boolean {
  return (Object.values(CAPABILITY_ENTITLEMENTS) as string[]).includes(entitlement);
}

/** Header names a plug-in may alias: the core's own `X-OHB-*` request headers. */
export const ALIAS_HEADER_RE = /^X-OHB-[A-Za-z][A-Za-z0-9-]{0,39}$/;
/** Query parameter names a plug-in may alias. */
export const ALIAS_QUERY_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
/** Absolute paths a plug-in may redirect: lower-case segments, no trailing slash. */
export const ALIAS_PATH_RE = /^(\/[a-z0-9][a-z0-9_-]*)+$/;

/**
 * Compatibility aliases (open-core step 11.2): a name the core no longer
 * knows but that is already out there (a header an old console tab sends, a
 * URL in an email, an entitlement key in a licence). The core keeps no alias
 * of its own; a plug-in that owns the old name declares it here, and the
 * core applies it generically:
 *
 * - `headers` / `queries`: the request carries `from` and not `to`, the core
 *   reads `from` as `to` (and lists `from` in the CORS allowed headers);
 * - `paths`: a request under `from` gets a 308 to the same rest under `to`,
 *   query kept, before any session check; never over a core route. An
 *   alias touching the session root (`SESSION_ALIAS_ROOT`) must be `exact`
 *   (that one path, no rest) and target a path of `SESSION_ALIAS_TARGETS`,
 *   the core's explicit allowlist: no alias may cover `/api/auth/*`;
 * - `entitlements`: `from`, declared by the plug-in under its own id, is
 *   held exactly when `to` is.
 */
export type CompatAlias = {
  readonly from: string;
  readonly to: string;
  /** Paths only: redirect `from` itself and nothing below it. */
  readonly exact?: boolean;
};

/** The root of the session routes: a path alias may touch it only exactly, towards an allowlisted target. */
export const SESSION_ALIAS_ROOT = "/api/auth";

/**
 * The only session paths an old path may be redirected to (open-core step
 * 11.4). Each one is a core route a plug-in once owned the name of; the
 * plug-in declares the old name, never the core.
 */
export const SESSION_ALIAS_TARGETS: readonly string[] = ["/api/auth/assisted-sessions/claim"];
export type CompatAliases = {
  readonly headers?: readonly CompatAlias[];
  readonly queries?: readonly CompatAlias[];
  readonly paths?: readonly CompatAlias[];
  readonly entitlements?: readonly CompatAlias[];
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
 * of `OHB_PRO_<ID>__<KEY>`: for a name that is already a deploy contract
 * (secret manager, a provider's dashboard), so that moving code into a
 * plug-in renames nothing on the deploy side. The core never reads it: it
 * hands the plug-in the declared names that are set (`HookContext.env`),
 * and the API refuses to start in production while a loaded plug-in misses
 * one marked `requiredInProduction`. A name the core itself declares (its
 * environment schema), an `OHB_*` name or a duplicate is refused by the
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
 * configuration (`OHB_PRO_<ID>__<KEY>`, indexed by KEY), never the whole
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
  /** `personal` or `agency` (`OrganizationKind`). */
  readonly kind: string;
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
   * One pass. `db` is the worker pool (a Bun `SQL`, role `ohb_worker`); the
   * pass must stop early when `signal` aborts (worker shutdown). A throw is
   * logged and the next pass runs on schedule.
   */
  readonly run: (db: unknown, context: HookContext & { readonly signal: AbortSignal }) => Promise<void>;
};

/** The browser of the person a support session is opened for, as the core reads it. */
export type ImpersonationDevice = { readonly userAgent: string | null; readonly ip: string | null };

/** A web session opened by a one-shot support claim, ready for the core's cookies. */
export type ImpersonationSession = {
  readonly token: string;
  readonly csrf: string;
  readonly organizationId: string;
  /** Lifetime of the session, and of its cookies. */
  readonly ttlMs: number;
};

/**
 * Assisted access to a member's account. The core owns the route
 * (`POST /api/auth/assisted-sessions/claim`), its origin check and the
 * cookies: a web session is the core's to write. The plug-in that runs the
 * backoffice owns the claim: it checks the one-shot code, opens the session
 * and records it. Without such a plug-in (solo) no assisted session can be
 * opened and the route answers 404.
 */
export type ImpersonationSource = {
  /** `db` is the API pool (a Bun `SQL`); `null` when the claim is unknown, used, expired or revoked. */
  readonly claim: (db: unknown, claimHash: string, device: ImpersonationDevice) => Promise<ImpersonationSession | null>;
};

/**
 * The help desk (open-core step 11.3): the public, sessionless routes a
 * visitor writes to support through. The core keeps the URL, `/api/support/*`,
 * mounted before the session middleware with its rate rules, its CORS header
 * (`X-OHB-Support-Token`) and its exclusion from compression; the plug-in
 * that runs the backoffice answers them. Without such a plug-in (solo) every
 * path under it is the core 404 `NOT_FOUND` and `/api/health` reports
 * `supportDesk: false`. At most one loaded plug-in provides it: the API keeps
 * the first and logs the others.
 *
 * `build` receives the same context as an API mount (`ProPluginContext`);
 * the router gets the path below `/api/support` and, as `env`,
 * `SupportDeskEnv`. A throw keeps the core error shape (`app.onError`).
 */
export type SupportDeskProvider<Router = unknown, Context = unknown> = {
  readonly build: (context: Context) => Router;
};

/** What a help desk router receives as `env`. */
export type SupportDeskEnv = { readonly clientIp: string | null };

/**
 * The entitlement that hands an organization's permission rules to the
 * `permissions` plug-in (PERM2, US-PERM2 v2). Without it, or without the
 * plug-in, the gate reads the core rules: the decisions are the same as solo.
 */
export const PERMISSIONS_V2_ENTITLEMENT = "permissions.v2" as const;

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
   * PERM2-6: the natural-language rules the automatic reviewer reads for one
   * bot, raw (the core filters them by `rulesMode`, then redacts and bounds
   * them). `tx` is the reviewer's own transaction. Absent: the core's.
   */
  readonly reviewRules?: (tx: unknown, query: ReviewRuleQuery) => Promise<ReviewRules>;
  /**
   * PERM2-9: whether nobody waits for a gate of this workflow ("Never wait").
   * `tx` holds the run, then the workflow, `for update`. Absent: the core's.
   */
  readonly unattended?: (tx: unknown, query: UnattendedQuery) => Promise<boolean>;
};

/** The bot whose rules the reviewer reads, and its organization. */
export type ReviewRuleQuery = { readonly organizationId: string; readonly botId: string };

/** The bot's rules and its organization's, oldest first, and the organization's rules mode (`null`: no policy). */
export type ReviewRules = {
  readonly rulesMode: string | null;
  readonly rules: readonly { readonly scope: "bot" | "organization"; readonly kind: string; readonly text: string }[];
};

/** The workflow a gate's run belongs to. */
export type UnattendedQuery = { readonly organizationId: string; readonly workflowId: string };

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
export const SUBSCRIPTION_PORT_MEMBERS = ["memberLimit", "status", "read", "readForUpdate", "admission"] as const;

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

export type ProPlugin<Router = unknown, Context = unknown> = {
  readonly manifest: ProPluginManifest;
  readonly api?: readonly ApiMount<Router, Context>[];
  readonly migrations?: MigrationSet;
  /** Module specifier of the console bundle exposing lazy routes; resolved by the console build. */
  readonly console?: { readonly module: string };
  readonly hooks?: CoreHooks;
  /** Recurring worker passes; the API ignores them. */
  readonly jobs?: readonly WorkerJob[];
  /** At most one loaded plug-in provides it; the API keeps the first and logs the others. */
  readonly impersonation?: ImpersonationSource;
  /** The help desk behind `/api/support/*` (`SupportDeskProvider`); same rule: one provider. */
  readonly supportDesk?: SupportDeskProvider<Router, Context>;
  /**
   * Only read from the plug-in `permissions`, which must declare
   * `permissions.v2`; used for an organization its `entitlementsFor` grants
   * `permissions.v2` to, the core rules otherwise.
   */
  readonly permissionRules?: PermissionRuleSource;
  /** Only read from the plug-in `billing`. */
  readonly billing?: BillingHooks;
  /** Old names this plug-in keeps answering (`CompatAliases`). */
  readonly aliases?: CompatAliases;
};
