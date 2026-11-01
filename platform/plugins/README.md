# @openedbot/platform-plugins

Contract and loader for optional pro plug-ins.
The core never imports a plug-in statically; it passes module specifiers to
`loadProPlugins`, which imports each with `import()`, validates it and skips
(with a warning) anything missing, invalid, incompatible or not licensed.

Wired into the API (`apps/api/src/application/pro-plugins.ts`): the list
comes from `OHB_PRO_PLUGINS` (empty or unset is solo mode, logged as
« mode: solo »); `api` mounts are served under `/api/pro/<id><prefix>` behind
the core `/api/*` middlewares, `session` mounts behind the session and their
entitlement; `migrations` are applied by `scripts/db.sh --migrate` (and any deployment
migrator) after the core and recorded as `<id>:<file>`;
`onOrganizationCreated` runs once per new organization, after its commit, and
a failing hook is logged without breaking the creation; a `session` mount
without its entitlement answers 404.
A `public` mount receives `{ pluginId, clientIp }` as `env`, the address read
by the core like its own routes (`null` when unknown).

`impersonation` (`ImpersonationSource`) is the assisted-session port: the core
keeps `POST /api/auth/assisted-sessions/claim`, its origin check and the
cookies, and hands the hashed one-shot code to the first loaded plug-in that
provides it. Without one (solo) the route answers 404 and no assisted session
can be opened.

A path alias (`aliases.paths`) is a 308 from an old path, declared by the
plug-in that owned it, installed only when that plug-in is loaded, and
dropped when it would shadow a core route. One touching `/api/auth`
(`SESSION_ALIAS_ROOT`) must be `exact: true` and target a path of
`SESSION_ALIAS_TARGETS`, the core's allowlist; no alias covers a subtree of
the session routes.

`permissionRules` (`PermissionRuleSource`) is the permission-rules port: the
core keeps the gate, its locks and the pure pipeline, and asks the source for
`{ organizationPolicy, toolPolicy, grants }` inside the run's transaction.
Only the plug-in `permissions` may provide it, declaring `permissions.v2`;
the worker uses it for an organization its `entitlementsFor` grants
`permissions.v2` to, and the core rules for every other one (solo
included), so `permissions.v2` off decides exactly as solo
(`apps/worker/tests/permission-golden.test.ts`).

`billing.webhook(request, context)` (`BillingHooks`) answers the payment
webhook at the path the plug-in declares, `billing.webhookPath` (step 11.5:
the core names no provider path). Only the plug-in `billing` may provide it.
The API mounts `POST <webhookPath>` before the session check, exempts it from
the session, hands the raw request over and returns the plug-in's response
as is (a throw is the core's 500); it refuses to start when a core route
answers that path too. The core checks no signature and holds no payment
logic: billing loaded but refused by the role guard answers
`503 PAYMENT_WEBHOOK_UNAVAILABLE` at its path; solo mounts nothing there
(`apps/api/tests/payment-webhook-route.test.ts`).

`manifest.env` declares deployment variables a plug-in reads under their
deployed name, for names that already are a deploy contract (step 11.5).
The loader refuses `OHB_*` names, names of the core environment schema and
duplicates; the hooks and mounts get the declared values that are set as
`context.env`, and in production the API does not start while a loaded
plug-in misses one marked `requiredInProduction`.

Wired into the worker (`apps/worker/src/application/pro-plugins.ts`), same
list and same role guard: it mounts nothing, reads the declared entitlements
(`billing.enforced`) and runs each `onTenantDeleting` hook inside the tenant
purge transaction, before the organization row is deleted; a failing or slow
hook (2 s) fails the purge, which is retried. It also schedules each `jobs`
entry next to the core maintenance jobs, single-flight, as
`pro:<id>:<name>` (at least one minute apart); `enabled(context)` is read once
at boot and a job it switches off is logged (`worker.pro_job_disabled`) and
never scheduled. Not wired yet: the console (`console.module`).

Every hook gets, as its last argument, a `HookContext` holding the plug-in's
own configuration only (`OHB_PRO_<ID>__<KEY>`, indexed by KEY, see
`pluginConfig`), the same one its API mounts receive.
