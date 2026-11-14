# Architecture and guards

This page explains how the core is layered, which offline guards hold those layers
in place, and what to do when one of them fails. Every guard below runs in
`make test-unit` or `make deps-check`, so `make check` runs them all, and so does
the `core-ci` workflow on every pull request.

The rule texts and error messages of most guards are in French; the file named in
each section is the source of truth.

## Layers

The monorepo is a set of Bun workspaces, one package per directory, each imported
by its package name (`@openedbot/...`):

| Layer | What lives there |
| --- | --- |
| `contracts/*` | Pure types and zod schemas shared by every side: `api`, `connector`, `errors`, `events`, `i18n`, `locale`, `native-bridge`, `primitives`. |
| `protocol/` | The reference of the wire protocol with edge-setup (`protocol/connector`), published on its own under Apache-2.0. `contracts/connector` re-exports it. |
| `platform/*` | Server infrastructure without product logic: `config` (environment schema), `db`, `hermes` (the runtime client), `integrations`, `observability`, `plugins` (the plug-in contract and loader). |
| `modules/*` | One package per business context: `identity`, `runtimes`, `runtime-link`, `roster`, `conversation`, `execution`, `portability`, `notifications`. Each one has `src/domain`, `src/application` and `src/sql`. |
| `browser/*` | Code for the browser: `api-client`, `face`, `i18n`, `ui-kit`. |
| `apps/*` | Composition roots: `api` (Hono), `worker`, `console` (the PWA, Vite), `link-gateway`, `desktop-tauri`. |

Imports only go one way:

```
   apps/api   apps/worker   apps/link-gateway               apps/console
        |           |              |                          |        |
        v           v              v                          |        v
   +-------------------------------------+    domain/ only    |  +-------------+
   |  modules/*                          | <------------------+  |  browser/*  |
   |  domain / application / sql         |                       +-------------+
   |  (only the modules declared in      |                              |
   |   their package.json, no cycle)     |                              |
   +-------------------------------------+                              |
        |                                                               |
        v                                                               |
   +-------------------------------------+                              |
   |  platform/*                         |                              |
   +-------------------------------------+                              |
        |                                                               |
        v                                                               v
   +--------------------------------------------------------------------------+
   |  contracts/*   (zod only, no Node, no Bun, no I/O)                       |
   +--------------------------------------------------------------------------+
        |
        v
   protocol/connector   (imports nothing from the repository)
```

Server apps import modules, platform and contracts. The console and `browser/`
import contracts, and the console may also use the pure `domain` layer of a
module, never its `application` or `sql` layer, nor `platform/`.
An app never imports another app, and no shared package imports an app.

## Import boundaries: `make deps-check`

`.dependency-cruiser.cjs` declares the boundaries; `make deps-check` checks them
on the sources, tests and root scripts included, without a build. Every rule is an
error. The main ones, by rule name:

- **Layers.** `contrat-sans-dependance-interne`, `contrat-zod-seul`,
  `contrat-sans-node`, `contrat-sans-bun`: a contract imports only other contracts
  and zod. `protocole-autonome`: `protocol/` imports nothing from the repository.
  `plateforme-sans-produit`: the platform imports no module and no browser code.
  `module-sans-navigateur`, `module-sans-hono`: a module knows neither the browser
  nor HTTP. `paquet-sans-app`, `app-sans-autre-app`: no package depends on an app,
  no app on another app.
- **Modules.** `module-par-ses-dependances`: a module imports only the modules its
  `package.json` declares. `sql-prive-au-module`: `modules/<m>/src/sql/` is
  imported only from inside `<m>`; everyone else goes through its `application`
  layer, which re-exports what it opens (see `modules/README.md`).
  `primitives-de-creation-privees`: the run and workflow creation primitives
  (`modules/execution/src/sql/run-writes.ts`) are imported only by the creation
  commands. `porte-permissions-par-le-port`: the execution module and the worker
  read permission rules only through the `PermissionRuleSource` port.
- **Browser.** `navigateur-sans-serveur`, `navigateur-sans-node`,
  `couche-navigateur-sans-serveur`, `couche-navigateur-sans-node`: the console and
  `browser/` load no server package, no module use case or SQL, no Node or Bun
  built-in. `console-plateforme-par-la-facade`: outside `src/lib/platform/`, the
  console reaches the desktop bridge only through the `lib/platform` facade.
- **Open core.** `pas-de-pro-statique`, `coeur-sans-staff`,
  `console-sans-ecrans-pro`: the core never imports a pro plug-in statically (see
  [Plug-in contract](#plug-in-contract)).
- **Hygiene.** `no-circular` (type-only imports excepted), `contrat-api-sans-cycle`
  (no cycle at all inside `contracts/api`), `not-to-unresolvable`,
  `not-to-dev-dep` (shipped code imports no devDependency),
  `production-sans-harnais` (shipped code imports neither `tests/` nor
  `scripts/`), `paquet-par-son-nom` (another package is imported by name, never by
  a relative path into its `src/`).

**When it fails**, the output names the rule, the importing file and the target.
Move the code to the layer it belongs to, or import through the owner's public
layer (for a module, `@openedbot/<module>/application/...`). A new module
dependency is declared in the module's `package.json`, and must not close a cycle.
Do not add a `pathNot` exception to make a violation pass.

`tests/scripts/workspace-deps-contract.ts` (in `make deps-check`) complements it:
every `@openedbot/*` package imported by a workspace's `src/` must be declared in
that workspace's `package.json` (Bun hoists workspaces, so an undeclared import
resolves locally and breaks a production image), and the declared graph has no
cycle. Fix: add the dependency to `package.json` and run `bun install`.

## File size cap and ratchet

`tests/scripts/code-structure-contract.ts` (in `make test-unit`) refuses any shipped
TypeScript file (`src/` of `apps`, `modules`, `platform`, `contracts`, `protocol`,
`browser`; tests, `.d.ts` and benches excluded) longer than **600 lines**.

Files that were already longer are listed in `tests/scripts/code-size-debt.json`
with their ceiling. The ceiling is a ratchet: such a file may shrink, never grow.

- *"N lignes, au-delà de 600"*: a new or growing file crossed the cap. Split it by
  responsibility. Never add it to the debt file by hand.
- *"au-delà de son plafond de dette"*: a file in debt grew. Split it before adding
  code to it.
- *"Abaissez le plafond (--record)"*: a file in debt shrank. Lock the gain with
  `bun tests/scripts/code-structure-contract.ts --record`, which only lowers
  ceilings, then commit the JSON.
- *"repassé sous 600"* or *"inscrit dans la dette mais absent"*: remove the entry
  from the JSON.

The same script also holds the domains of `contracts/api/src/`: each folder is a
domain, the imports between domains form a graph without cycle, and `shared/`
imports no domain. Two domains that need each other are one domain.

## Foreign reads and run writes

Every table has one owning context in `db/ownership.json` (a module, an app, or a
plug-in leaving the core).

- **Writes**: `tests/scripts/db-ownership-contract.sh` checks that every live table
  has an owner, and that a context writes only the tables it owns or those whose
  entry lists it in `writers`. Fix: write through the owner's `application` layer;
  a new table needs an entry in `db/ownership.json`.
- **Foreign reads**: `tests/scripts/foreign-reads-contract.ts` counts, per file and
  per table, the inline SQL reads (`from` / `join` in the shipped code of
  `modules/*/src` and `apps/*/src`) of a table another context owns. The existing
  reads are frozen in `tests/scripts/foreign-reads-debt.json`. A count may go
  down, never up, and a file or table that is not listed may not start reading.
  Fix: read through the owner's `application` layer. When you removed reads, run
  `bun tests/scripts/foreign-reads-contract.ts --record` to lower the counts.
- **Run writes**: `tests/scripts/run-writes-contract.ts` keeps the run lifecycle in
  one place. Creating runs and workflows (`insert into runs|workflows`,
  `delete from`, a workflow step claim) only happens in
  `modules/execution/src/sql/run-writes.ts`, imported only by the creation
  commands; `update runs` only happens in `sql/run-transitions.ts` (the only
  writer of `status`, `external_state` and `remote_stop_state`) and
  `sql/run-columns.ts`. The remaining inline `update workflows` statements are
  counted per file in `tests/scripts/run-writes-debt.json`, as a ratchet like the
  foreign reads (`--record` lowers it). Fix: call the transition or column
  function instead of writing SQL inline.

Both ratchets carry an `until` date; past it the contract warns instead of failing.
Comments are blanked before matching, so prose that names a table is not a read.

## Payment provider

`tests/scripts/payment-provider-contract.ts` (in `make deps-check`) refuses any
mention of the payment provider's name in the core runtime: the `src/` of apps,
modules, platform, contracts and browser packages, and `scripts/`. Tests and
fixtures may name it. Billing belongs to the external `billing` plug-in; the core
only knows the neutral contract (`BillingHooks`, `SubscriptionPort`,
`PAYMENT_WEBHOOK_UNAVAILABLE`). Fix: express the need through that contract
instead of naming a vendor.

Two sibling scripts guard the other ports the same way:
`tests/scripts/permission-port-contract.ts` and
`tests/scripts/subscription-port-contract.ts`.

## i18n parity

`contracts/i18n/tests/parity.test.ts` (in `make test-unit`) requires the French
(`contracts/i18n/src/messages.fr.ts`) and English (`messages.en.ts`) dictionaries to
expose exactly the same leaf keys, and the core dictionaries to carry no
back-office (`staff*`) namespace. The failure lists the keys missing on each side.
Fix: add the key to both languages in the same change; never leave one side
empty or copy the other language's text as a placeholder.

## Documentation site scope

The documentation site in `docs/` (Astro Starlight) has its own tests; run them
with `bun test` from `docs/`. `docs/tests/scope.test.ts` checks
`docs/src/lib/docs-scope.ts`:

- every `.mdx` page under `src/content/docs/docs/` (English) and
  `src/content/docs/fr/docs/` (French) is listed in `SIDEBAR_SECTIONS`, and every
  listed page exists in **both** languages;
- a public build (`DOCS_SCOPE=public`, the production default) only loads the
  public pages; the developer reference and the pages still in development are
  built only with `DOCS_SCOPE=all`.

Fix: a new page gets an `.mdx` file in both languages and an entry in
`SIDEBAR_SECTIONS`, in the section that sets its visibility; update the expected
lists of the test when you deliberately change which pages are public.

## Plug-in contract

The open core runs on its own ("solo"); paid features live in plug-ins kept in a
separate repository. `platform/plugins/src/contract.ts` is the only interface
between them:

- The core never imports a plug-in statically (`pas-de-pro-statique`,
  `coeur-sans-staff`). The API and the worker receive module specifiers through
  `OPENEDBOT_PLUGINS`, load them with `import()` and keep only those
  `loadProPlugins` (`platform/plugins/src/loader.ts`) accepts. Without any plug-in
  the core builds, tests and runs unchanged; the CI runs it solo.
- A plug-in exports a manifest (`ProPluginManifest`: id, version, the
  `PLUGIN_API_VERSION` it targets, the entitlements it can grant, optional
  deployment variables) and optionally API routes mounted under
  `/api/pro/<id>`, SQL migrations applied after the core ones and recorded as
  `<id>:<file>`, a lazy console bundle, recurring worker jobs, compatibility URL
  aliases, and hooks (`CoreHooks`: entitlements, organization creation, tenant
  deletion).
- Narrow ports let a plug-in replace a core behaviour without the core naming it:
  `PermissionRuleSource` (permission rules, entitlement `permissions.v2`) and
  `BillingHooks` / `SubscriptionPort` (read only from the plug-in `billing`).
- Each plug-in reads only its own configuration
  (`OPENEDBOT_PLUGIN_<ID>__<KEY>`, or names it declares), never the core's
  variables.

Changing a type in `contract.ts` changes what external plug-ins compile against:
bump `PLUGIN_API_VERSION` when a field changes meaning. `make test-dual` runs the
unit tests solo, then with the plug-ins of a local `./plugins` checkout when you
have one.
