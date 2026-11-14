# @openedbot/platform-plugins

Contract and loader for optional pro plug-ins.
The core never imports a plug-in statically; it passes module specifiers to
`loadProPlugins`, which imports each with `import()`, validates it and skips
(with a warning) anything missing, invalid, incompatible or not licensed.

Wired into the API (`apps/api/src/application/pro-plugins.ts`): the list
comes from `OPENEDBOT_PLUGINS` (empty or unset is solo mode, logged as
« mode: solo »); `api` mounts are served under `/api/pro/<id><prefix>` behind
the core `/api/*` middlewares, `session` mounts behind the session and their
entitlement; `migrations` are applied by `scripts/db.sh --migrate` (and any deployment
migrator) after the core and recorded as `<id>:<file>`;
`onOrganizationCreated` runs once per new organization, after its commit, and
a failing hook is logged without breaking the creation; a `session` mount
without its entitlement answers 404.
A `public` mount receives `{ pluginId, clientIp }` as `env`, the address read
by the core like its own routes (`null` when unknown).

A path alias (`aliases.paths`) is a 308 from an old path, declared by the
plug-in that owned it, installed only when that plug-in is loaded, and
dropped when it would shadow a core route. No alias touches the session
routes (`SESSION_ALIAS_ROOT`, `/api/auth`).

`permissionRules` (`PermissionRuleSource`) is the permission-rules port: the
core keeps the gate, its locks and the pure pipeline, and asks the source for
`{ organizationPolicy, toolPolicy, grants }` inside the run's transaction.
Only the plug-in `permissions` may provide it, declaring `permissions.v2`;
the worker uses it for an organization its `entitlementsFor` grants
`permissions.v2` to, and the core rules for every other one (solo
included), so `permissions.v2` off decides exactly as solo
(`apps/worker/tests/permission-golden.test.ts`).

`approvalReviewer` (`ApprovalReviewerPort`) is the automatic approval
reviewer, also only from the plug-in `permissions`. The core holds no
natural-language rule and no reviewer: without it `ready` is false for every
organization, so `auto` acts as `manual`, a new bot starts in `manual`, no
gate is born `reviewing`, and the worker's `approval-review-handoff` pass
hands any gate left under review to a person. With it, the API and the
worker ask `ready(tx, organizationId)` (in a savepoint of the caller's
transaction) and the worker schedules its `passes` as
`pro:permissions:<name>` (at least 250 ms apart), lending them
`host: { config }` and its drain (`track`).

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

`auditArchive` (`AuditArchivePort`) is the external archive of the creation
audit. Only the plug-in `audit` may provide it. The core's default, without
it, is PostgreSQL only: the local hash chain (`audit_chain`) is the core's
anchoring, verifications say `worm: disabled`, and no environment requires
anything external. With it, the API and the link gateway hand every chained
anchor and verdict to `put` inside the business transaction, re-read an
archived anchor with `get` when an export is verified, and call `orphaned`
after a transaction that attempted deposits rolled back. A failed `put`
blocks the write for an organization holding `audit.anchor` (API only) and
is logged as `worm_write_failed` otherwise. The archive's own variables are
the plug-in's `manifest.env` (`requiredInProduction`).

`OPENEDBOT_REQUIRED_PLUGINS` (comma-separated plug-in ids, `manifest.id`) turns
the loader's permissive skip into a fail-fast start. The loader never throws: a
listed plug-in that cannot be imported, is invalid, refused, or dropped by the
row-level-security guard is skipped and the process runs solo. A deployment
that sells what a plug-in brings sets, for instance, `audit,permissions`: the
API, the worker and the link gateway each check the ids against the plug-ins
they finally keep (`assertRequiredPlugins`, `src/required.ts`) and exit
non-zero at startup with one line naming the missing ids
(`api.required_plugins_missing`, `worker.required_plugins_missing`,
`runtime_link.required_plugins_missing`) and the loader's skip reasons. A
malformed id fails the same way. Empty or unset: no requirement.

`manifest.env` declares deployment variables a plug-in reads under their
deployed name, for names that already are a deploy contract (step 11.5).
The loader refuses `OPENEDBOT_*` names, names of the core environment schema and
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
own configuration only (`OPENEDBOT_PLUGIN_<ID>__<KEY>`, indexed by KEY, see
`pluginConfig`), the same one its API mounts receive.
