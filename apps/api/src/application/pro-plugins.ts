/**
 * Pro plug-ins in the API.
 *
 * `OHB_PRO_PLUGINS` lists module specifiers; empty or unset is solo mode and
 * nothing below changes a single route. Each loaded plug-in's API mounts are
 * served under `/api/pro/<id><prefix>`, behind the same `/api/*` middlewares
 * as the core (security headers, compression, rate limiting, then the
 * session for `session` mounts). A plug-in router is anything with
 * `fetch(request, env)`: the core strips the mount path and passes the
 * caller's identity in `env`, so plug-ins need not share the core's Hono copy.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  BILLING_PLUGIN_ID,
  capabilitiesOf,
  hookContext,
  loadProPlugins,
  missingProductionEnv,
  parsePluginList,
  pluginConfig,
  pluginDeployEnv,
  type ApiMount,
  type BillingHooks,
  type ImpersonationSource,
  type LoadedPlugins,
  type LoadOptions,
  type OrganizationCreatingEvent,
  type PluginSkip,
  type ProPlugin,
  type SupportDeskEnv,
  type SupportDeskProvider,
} from "@openedbot/platform-plugins";
import type { Db } from "@openedbot/platform-db";
import type { SubscriptionPort } from "@openedbot/platform-db/subscription-port";
import type { OrganizationKind } from "@openedbot/contracts-api";
import { readDbRoleFacts, tenantRoleProblem } from "@openedbot/platform-db/role-guard";
import { requestClientIp } from "@openedbot/platform-config/rate-limit";
import { isCoreEnvName } from "@openedbot/platform-config/env-schema";
import { shadowsCoreRoute } from "./compat-aliases";

export const PRO_API_ROOT = "/api/pro";

/** The body of the core `app.notFound`. */
const NOT_FOUND_BODY = { error: { code: "NOT_FOUND", message: "Route introuvable." } } as const;

/**
 * What a mount's `build()` receives. `db` is the API pool, which connects
 * with the application role (row-level security applies: no superuser, no
 * BYPASSRLS, owns no table; see `guardProPlugins`). `config` holds only the
 * plug-in's own variables, `OHB_PRO_<ID>__<KEY>`, keyed by `<KEY>`.
 */
export type ProPluginContext = {
  readonly pluginId: string;
  readonly db: Db;
  readonly config: Readonly<Record<string, string>>;
  /** Its declared deployment variables that are set (`HookContext.env`); absent when it declares none. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Services the API lends to a plug-in it installs itself (legacy install,
   * until step 8), keyed by plug-in id. Never set for `OHB_PRO_PLUGINS`
   * plug-ins other than the ones the API knows.
   */
  readonly host?: Readonly<Record<string, unknown>>;
};

/** What a plug-in router receives as `env` on a `session` mount. */
export type ProSessionEnv = {
  readonly pluginId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  /**
   * The fleet organization acting for the client under a mandate (`role` is
   * then `agency`), `null` for a member of the organization. The core's
   * owner-only guard covers `/api/organization*` only: a plug-in route that
   * is reserved to the client decides it from this.
   */
  readonly actingFleetId: string | null;
  /**
   * The kind of the session's organization (`personal` or `agency`), `null`
   * when the session has no organization kind. Read from the session, like
   * the core's own routes (billing, fleet routes); a plug-in never queries
   * it again.
   */
  readonly organizationKind: OrganizationKind | null;
  /**
   * Who assists this session (a support session opened for the user), `null`
   * otherwise (step 8d: the plug-in billing decides the `fleet.billing`
   * capability for the same viewer as the core did, staff audience
   * included). Neutral name since step 11.3 (in-process contract, core and
   * pro deploy together: no alias); the caller and the session keep
   * `impersonatedByStaffUserId`, the DB column's name (dated debt).
   */
  readonly assistedBy: string | null;
};

/**
 * What a plug-in router receives as `env` on a `public` mount. `clientIp` is
 * read by the core exactly like its own routes (socket address, or the last
 * `X-Forwarded-For` hop behind a trusted proxy); `null` when unknown.
 */
export type ProPublicEnv = { readonly pluginId: string; readonly clientIp: string | null };

/** The router a mount's `build()` must return. */
export type ProRouter = {
  fetch(request: Request, env: ProSessionEnv | ProPublicEnv): Response | Promise<Response>;
};

/** Does this organization hold this entitlement? The API passes its `EntitlementSource`. */
export type ProEntitlementCheck = (organizationId: string, entitlement: string) => Promise<boolean>;

/**
 * The session gate of a `session` mount: does this caller hold the mount's
 * entitlement? Read for the whole caller (organization AND viewer: user,
 * support session), the way the core's own routes read a product switch.
 */
export type ProCallerEntitlementCheck = (caller: ProCaller, entitlement: string) => Promise<boolean>;

/** The authenticated caller as the core's session middleware leaves it. */
export type ProCaller = {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly actingFleetId?: string | null;
  readonly organizationKind?: OrganizationKind | null;
  readonly impersonatedByStaffUserId?: string | null;
};

/** A plug-in never declares one of the core's variables as its own (`manifest.env`). */
export async function loadApiProPlugins(value: string | undefined, options: LoadOptions = {}): Promise<LoadedPlugins> {
  return loadProPlugins(parsePluginList(value), { reservedEnv: isCoreEnvName, ...options });
}

/**
 * Production only: the API refuses to start while a LOADED plug-in misses
 * one of its `requiredInProduction` deployment variables (solo requires
 * none). Checked on what the loader kept, before the role guard: a plug-in
 * listed and loaded is a deployment that means to serve it.
 */
export function assertProPluginProductionEnv(plugins: readonly ProPlugin[], env: Readonly<Record<string, string | undefined>>): void {
  const missing = missingProductionEnv(plugins, env);
  if (missing.length > 0) throw new Error(`Required in production by the loaded plug-ins: ${missing.join(", ")}.`);
}

/** The startup line: « mode: solo » or « mode: pro, plugins: [a, b] ». */
export function proModeLabel(plugins: readonly ProPlugin[]): string {
  if (plugins.length === 0) return "mode: solo";
  return `mode: pro, plugins: [${plugins.map((plugin) => plugin.manifest.id).join(", ")}]`;
}

export function proMountPath(plugin: ProPlugin, mount: ApiMount): string {
  return `${PRO_API_ROOT}/${plugin.manifest.id}${mount.prefix === "/" ? "" : mount.prefix}`;
}

/** Paths the core session middleware must let through: only the `public` mounts. */
export function proPublicPathMatcher(plugins: readonly ProPlugin[]): (path: string) => boolean {
  const roots = plugins.flatMap((plugin) =>
    (plugin.api ?? []).filter((mount) => mount.access === "public").map((mount) => proMountPath(plugin, mount)));
  if (roots.length === 0) return () => false;
  return (path) => roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * What the loaded plug-ins grant, the plug-in layer of the core
 * `EntitlementSource`: an organization holds a plug-in entitlement when a
 * loaded plug-in's `entitlementsFor` hook returns it, and a plug-in can only
 * grant the entitlements its own manifest declares. A failing hook grants
 * nothing.
 */
export function hookEntitlementCheck(
  plugins: readonly ProPlugin[],
  warn: (event: { pluginId: string; error: string }) => void = () => undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): ProEntitlementCheck {
  const contexts = new Map(plugins.map((plugin) => [plugin.manifest.id, hookContext(plugin, env)]));
  return async (organizationId, entitlement) => {
    for (const plugin of plugins) {
      const hook = plugin.hooks?.entitlementsFor;
      if (!hook || !plugin.manifest.entitlements.includes(entitlement)) continue;
      try {
        if ((await hook(organizationId, contexts.get(plugin.manifest.id))).includes(entitlement)) return true;
      } catch (error) {
        warn({ pluginId: plugin.manifest.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return false;
  };
}

/**
 * Runs every plug-in `onOrganizationCreated` hook, never throws. The API
 * installs it as the identity listener (`installOrganizationCreatedListener`),
 * called once per organization after the creation has committed.
 */
export async function notifyOrganizationCreated(
  plugins: readonly ProPlugin[],
  organizationId: string,
  warn: (event: { pluginId: string; error: string }) => void = () => undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<void> {
  for (const plugin of plugins) {
    const hook = plugin.hooks?.onOrganizationCreated;
    if (!hook) continue;
    try {
      await hook(organizationId, hookContext(plugin, env));
    } catch (error) {
      warn({ pluginId: plugin.manifest.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Routes of the `public` mounts; register BEFORE the core session middleware. */
export function proPublicRoutes<Ctx>(
  plugins: readonly ProPlugin[],
  contextFor: (plugin: ProPlugin) => Ctx,
  warn: MountWarning = () => undefined,
  options: { trustProxy?: boolean } = {},
): Hono {
  const app = new Hono();
  for (const plugin of plugins) {
    for (const mount of plugin.api ?? []) {
      if (mount.access !== "public") continue;
      const router = buildRouter(plugin, mount, contextFor, warn);
      if (!router) continue;
      const path = proMountPath(plugin, mount);
      const optionHandler = (context: Context) => ({
        pluginId: plugin.manifest.id,
        clientIp: proClientIp(context, options.trustProxy ?? false),
      }) satisfies ProPublicEnv;
      app.mount(path, (request, env) => router.fetch(request, env as ProPublicEnv), { optionHandler });
    }
  }
  return app;
}

function proClientIp(context: Context, trustProxy: boolean): string | null {
  const server = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  const ip = requestClientIp(context.req.raw, server, trustProxy);
  return ip === "unknown" ? null : ip;
}

/**
 * The support-session source among the loaded plug-ins: the first one that
 * provides it. Any other is ignored and reported, never merged.
 */
export function impersonationSourceOf(
  plugins: readonly ProPlugin[],
  warn: (event: { pluginId: string; keptPluginId: string }) => void = () => undefined,
): ImpersonationSource | null {
  let kept: { pluginId: string; source: ImpersonationSource } | null = null;
  for (const plugin of plugins) {
    if (!plugin.impersonation) continue;
    if (kept) warn({ pluginId: plugin.manifest.id, keptPluginId: kept.pluginId });
    else kept = { pluginId: plugin.manifest.id, source: plugin.impersonation };
  }
  return kept?.source ?? null;
}

/**
 * The help desk provider among the loaded plug-ins: the first one that
 * provides `supportDesk`. Any other is ignored and reported, never merged.
 */
export function supportDeskOf(
  plugins: readonly ProPlugin[],
  warn: (event: { pluginId: string; keptPluginId: string }) => void = () => undefined,
): { readonly plugin: ProPlugin; readonly desk: SupportDeskProvider } | null {
  let kept: { plugin: ProPlugin; desk: SupportDeskProvider } | null = null;
  for (const plugin of plugins) {
    if (!plugin.supportDesk) continue;
    if (kept) warn({ pluginId: plugin.manifest.id, keptPluginId: kept.plugin.manifest.id });
    else kept = { plugin, desk: plugin.supportDesk };
  }
  return kept;
}

/** Where the core serves the help desk (`SupportDeskProvider`). */
export const SUPPORT_DESK_PATH = "/api/support";

/**
 * The routes under `SUPPORT_DESK_PATH` (full paths, for `app.route("/", …)`
 * BEFORE the session middleware): the provider's router (built once, with
 * the same context as an API mount; it receives the path below
 * `SUPPORT_DESK_PATH`), or, without a provider or when its build fails
 * (logged through `warn`), the core 404 `NOT_FOUND` for every path under it:
 * never the session middleware's 401.
 */
export function supportDeskRoutes<Ctx>(
  provider: { readonly plugin: ProPlugin; readonly desk: SupportDeskProvider } | null,
  contextFor: (plugin: ProPlugin) => Ctx,
  warn: MountWarning = () => undefined,
  options: { trustProxy?: boolean } = {},
): Hono {
  const app = new Hono();
  const router = provider
    ? buildRouter(provider.plugin, { prefix: SUPPORT_DESK_PATH, access: "public", build: provider.desk.build }, contextFor, warn)
    : null;
  if (!router) {
    app.all(SUPPORT_DESK_PATH, (context) => context.json(NOT_FOUND_BODY, 404));
    app.all(`${SUPPORT_DESK_PATH}/*`, (context) => context.json(NOT_FOUND_BODY, 404));
    return app;
  }
  const optionHandler = (context: Context) => ({ clientIp: proClientIp(context, options.trustProxy ?? false) }) satisfies SupportDeskEnv;
  app.mount(SUPPORT_DESK_PATH, (request, env) => router.fetch(request, env as never), { optionHandler });
  return app;
}

/** What the core route lends the webhook of the plug-in billing (`BillingHookContext.host`). */
export type PaymentWebhookDelegate = (request: Request, host?: unknown) => Promise<Response>;

/**
 * The payment webhook of the plug-in `billing` (the loader refuses `billing`
 * hooks from any other id), bound to its own configuration and declared
 * deployment variables; `host` is what the core route lends it
 * (`{ db, config }`). `null` without it: the core route answers 503
 * `PAYMENT_WEBHOOK_UNAVAILABLE`.
 */
export function paymentWebhookOf(
  plugins: readonly ProPlugin[],
  env: Readonly<Record<string, string | undefined>> = {},
): PaymentWebhookDelegate | null {
  const billing = plugins.find((plugin) => plugin.manifest.id === BILLING_PLUGIN_ID);
  const hooks: BillingHooks | undefined = billing?.billing;
  if (!billing || !hooks) return null;
  const context = hookContext(billing, env);
  return (request, host) => hooks.webhook(request, host === undefined ? context : { ...context, host });
}

/** Where the core mounts the payment webhook, and who answers it there (`null`: 503). */
export type PaymentWebhookMount = { readonly path: string; readonly delegate: PaymentWebhookDelegate | null };

/**
 * The payment webhook mount (step 11.5): the path the plug-in `billing`
 * declares (`billing.webhookPath`), read on what the loader KEPT, so that a
 * billing refused by the role guard still answers 503
 * `PAYMENT_WEBHOOK_UNAVAILABLE` at its path, never a silent 404; the
 * delegate from what is INSTALLED. `null` without billing (solo): the core
 * mounts nothing, it knows no payment path of its own.
 */
export function paymentWebhookMountOf(
  loaded: readonly ProPlugin[],
  installed: readonly ProPlugin[],
  env: Readonly<Record<string, string | undefined>> = {},
): PaymentWebhookMount | null {
  const path = loaded.find((plugin) => plugin.manifest.id === BILLING_PLUGIN_ID)?.billing?.webhookPath;
  if (!path) return null;
  return { path, delegate: paymentWebhookOf(installed, env) };
}

/**
 * The routes, besides the webhook's own `POST`, that answer the webhook
 * path: the API refuses to start on any (`assertPaymentWebhookPathFree`).
 * Middlewares and mounts (`ALL`) are not routes.
 */
export function paymentWebhookConflicts(path: string, routes: readonly { readonly method: string; readonly path: string }[]): string[] {
  let own = false;
  return routes.filter((route) => {
    if (!own && route.method === "POST" && route.path === path) {
      own = true;
      return false;
    }
    return shadowsCoreRoute(path, [route]);
  }).map((route) => `${route.method} ${route.path}`);
}

export function assertPaymentWebhookPathFree(
  mount: PaymentWebhookMount | null,
  routes: readonly { readonly method: string; readonly path: string }[],
): void {
  if (!mount) return;
  const conflicts = paymentWebhookConflicts(mount.path, routes);
  if (conflicts.length > 0) {
    throw new Error(`billing.webhookPath ${mount.path} is also served by the core: ${conflicts.join(", ")}.`);
  }
}

/**
 * The subscription port of the plug-in `billing` (`billing.subscriptions`,
 * checked by the loader), `null` without it: identity, the run queue and the
 * routines then read `NO_SUBSCRIPTIONS` (solo: no limit, no paywall).
 */
export function subscriptionPortOf(plugins: readonly ProPlugin[]): SubscriptionPort | null {
  const port = plugins.find((plugin) => plugin.manifest.id === BILLING_PLUGIN_ID)?.billing?.subscriptions;
  return port ? port as unknown as SubscriptionPort : null;
}

/**
 * `onOrganizationCreating` of the plug-in billing (the loader refuses it from
 * any other id), bound to its own configuration, for identity's creation
 * transaction (`installOrganizationCreatingListener`). `null` without it
 * (solo): no welcome subscription is written. Errors are NOT caught here:
 * identity turns them into a rollback of the creation.
 */
export function organizationCreatingHookOf(
  plugins: readonly ProPlugin[],
  env: Readonly<Record<string, string | undefined>> = {},
): ((tx: unknown, event: OrganizationCreatingEvent) => Promise<void>) | null {
  const billing = plugins.find((plugin) => plugin.manifest.id === BILLING_PLUGIN_ID);
  const hook = billing?.hooks?.onOrganizationCreating;
  if (!billing || !hook) return null;
  const context = hookContext(billing, env);
  return (tx, event) => hook(tx, event, context);
}

/** Routes of the `session` mounts; register AFTER the core session middleware. */
export function proSessionRoutes<Ctx>(
  plugins: readonly ProPlugin[],
  contextFor: (plugin: ProPlugin) => Ctx,
  options: { entitled: ProCallerEntitlementCheck; caller: (context: Context) => ProCaller | undefined; warn?: MountWarning },
): Hono {
  const app = new Hono();
  for (const plugin of plugins) {
    for (const mount of plugin.api ?? []) {
      if (mount.access !== "session") continue;
      const path = proMountPath(plugin, mount);
      const router = buildRouter(plugin, mount, contextFor, options.warn ?? (() => undefined));
      if (!router) continue;
      const gate: MiddlewareHandler = async (context, next) => {
        const caller = options.caller(context);
        if (!caller) return context.json({ error: { code: "UNAUTHENTICATED", message: "Session requise." } }, 401);
        if (!mount.entitlement || !(await options.entitled(caller, mount.entitlement).catch(() => false))) {
          // Without the entitlement the route does not exist for this
          // organization: the same 404 as any unknown route, so nothing
          // leaks and the console never keys off a plug-in status code
          // (it reads `entitlements` from `GET /api/auth/me`).
          return context.json(NOT_FOUND_BODY, 404);
        }
        await next();
      };
      app.use(path, gate);
      app.use(`${path}/*`, gate);
      app.mount(path, (request, env) => router.fetch(request, env as ProSessionEnv), {
        optionHandler: (context) => {
          const caller = options.caller(context)!;
          return {
            pluginId: plugin.manifest.id,
            organizationId: caller.organizationId,
            userId: caller.userId,
            role: caller.role,
            actingFleetId: caller.actingFleetId ?? null,
            organizationKind: caller.organizationKind ?? null,
            assistedBy: caller.impersonatedByStaffUserId ?? null,
          } satisfies ProSessionEnv;
        },
      });
    }
  }
  return app;
}

/** Skips logged by the loader, with a shape fit for the structured logger. */
export function describeSkip(skip: PluginSkip): { specifier: string; reason: string } {
  return { specifier: skip.specifier, reason: skip.reason };
}

/** A mount whose `build()` throws or returns no router is skipped, like a plug-in the loader refuses. */
export type MountWarning = (event: { pluginId: string; prefix: string; error: string }) => void;

function buildRouter<Ctx>(plugin: ProPlugin, mount: ApiMount, contextFor: (plugin: ProPlugin) => Ctx, warn: MountWarning): ProRouter | null {
  const skip = (error: string) => {
    warn({ pluginId: plugin.manifest.id, prefix: mount.prefix, error });
    return null;
  };
  let router: unknown;
  try {
    router = (mount as ApiMount<unknown, Ctx>).build(contextFor(plugin));
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
  if (typeof router !== "object" || router === null || typeof (router as ProRouter).fetch !== "function") {
    return skip("build() did not return a router with fetch()");
  }
  return router as ProRouter;
}

export { pluginConfig, pluginConfigPrefix } from "@openedbot/platform-plugins";

/**
 * `hosts` maps a plug-in id to the services the API lends it; a plug-in only
 * ever sees its own entry (`context.host[<its id>]`), never another's. An
 * entry keyed by a capability (`fleet`) goes to the plug-in that declares
 * that capability's entitlements (`capabilitiesOf`), whatever its id.
 */
export function proPluginContext(
  plugin: ProPlugin,
  db: Db,
  env: Readonly<Record<string, string | undefined>>,
  hosts: Readonly<Record<string, unknown>> = {},
): ProPluginContext {
  const id = plugin.manifest.id;
  const keys = [id, ...capabilitiesOf(plugin)].filter((key) => Object.hasOwn(hosts, key));
  const host = keys.length > 0 ? Object.freeze(Object.fromEntries(keys.map((key) => [key, hosts[key]]))) : undefined;
  const deploy = pluginDeployEnv(plugin.manifest.env, env);
  return Object.freeze({ pluginId: id, db, config: pluginConfig(id, env), ...(deploy ? { env: deploy } : {}), ...(host ? { host } : {}) });
}

export { readDbRoleFacts, tenantRoleProblem, type DbRoleAttributes, type DbRoleFacts } from "@openedbot/platform-db/role-guard";

/**
 * Plug-ins only ever get a database handle under row-level security. If the
 * API pool's role could bypass it (or the check cannot run), every plug-in
 * is dropped with an error and the API starts in solo mode.
 */
export async function guardProPlugins(
  plugins: readonly ProPlugin[],
  db: Db,
  refuse: (reason: string) => void,
): Promise<readonly ProPlugin[]> {
  if (plugins.length === 0) return plugins;
  let problem: string | null;
  try {
    problem = tenantRoleProblem(await readDbRoleFacts(db));
  } catch (error) {
    problem = `role check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!problem) return plugins;
  refuse(problem);
  return [];
}
