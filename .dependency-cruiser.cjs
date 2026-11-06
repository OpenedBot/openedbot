/**
 * Les frontières du monorepo, vérifiées par `make deps-check` et la CI.
 *
 * Deux familles de règles, toutes en erreur : une violation casse la CI.
 *
 * Les premières décrivent ce qui est vrai AUJOURD'HUI dans le code de
 * production (`apps/*\/src`, `platform/*\/src`). Les
 * harnais de la racine (`tests/`, `scripts/`) et les tests des paquets peuvent
 * lire le code qu'ils éprouvent.
 *
 * Les secondes posent les couches de l'architecture cible (`contracts/`,
 * `browser/`, `platform/`, `modules/`). Elles passent sans rien trouver tant
 * qu'une couche est vide, et tiennent dès le premier fichier qui y entre.
 *
 * Trois exceptions nommées : `apps/console/vite.config.ts` et
 * `apps/admin/vite.config.ts` importent `client-env` par chemin relatif, parce
 * qu'esbuild laisse externe un nom de paquet quand il charge une config Vite ;
 * `apps/api/tests/early-fanout-sse.test.ts` éprouve la dédup SSE du client
 * (`apps/console/src/lib/stream/thread-stream-live.ts`) contre le fan-out de l'API.
 */
const TESTS = "(\\.test\\.tsx?$|/e2e/|/tests/)";

/**
 * Les écrans pro de la console (open-core, étape 9) : agence, facturation,
 * règles de permission. Depuis l'étape 11 ils vivent tous dans le dépôt de
 * plug-ins externe (`packages/<plug-in>/console/`) et n'entrent dans un bundle
 * que par leur module console, listé dans `OPENEDBOT_CONSOLE_PLUGINS`. Les chemins
 * ci-dessous n'existent plus dans le cœur : la règle garde contre leur retour.
 * La plomberie des espaces (sélecteur, onboarding, gardes de route) vit dans
 * `components/workspace/`.
 */
const PRO_CONSOLE_SCREENS =
  "^apps/console/src/(components/agency/|screens/agency/|screens/settings/agency/|" +
  "screens/auth/agency-invitation\\.tsx$|screens/settings/dev/billing\\.tsx$|components/settings/permission-rules\\.tsx$)";

module.exports = {
  forbidden: [
    {
      name: "pas-de-pro-statique",
      comment:
        "Le coeur ne charge un plug-in pro (`@openedbot/pro-*`) que par `import()` via `@openedbot/platform-plugins` : " +
        "il doit compiler, se tester et tourner sans aucun paquet pro.",
      severity: "error",
      from: {},
      to: { path: "(^|/)node_modules/@openedbot/pro-|^@openedbot/pro-", dependencyTypesNot: ["dynamic-import"] },
    },
    {
      name: "console-sans-ecrans-pro",
      comment:
        "Le code de la console n'importe aucun écran pro (agence, facturation, règles de permission) : ils n'entrent " +
        "dans un bundle que par le `console/` de leur paquet (dépôt de plug-ins externe), listé dans `OPENEDBOT_CONSOLE_PLUGINS` (`vite-pro-console.ts`). Un import direct les remettrait dans " +
        "le bundle solo (`make solo-check`). Les types seuls ne comptent pas (`src/pro-console/contract.ts`).",
      severity: "error",
      from: { path: "^apps/console/", pathNot: `${PRO_CONSOLE_SCREENS}|^apps/console/tests/` },
      to: { path: PRO_CONSOLE_SCREENS, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "console-plateforme-par-la-facade",
      comment:
        "Hors de `src/lib/platform/`, la console passe par la façade `lib/platform` (`index.ts`), jamais par le pont de " +
        "l'app de bureau (`native-bridge.ts`) : une seule porte, qui sait aussi l'URL publique de la console et l'en-tête " +
        "client (ADR 0001, étape D1a). Les tests peuvent le simuler directement.",
      severity: "error",
      from: { path: "^apps/console/", pathNot: "^apps/console/src/lib/platform/|^apps/console/tests/" },
      to: { path: "^apps/console/src/lib/platform/native-bridge\\.ts$" },
    },
    {
      name: "console-testing-hors-ecrans",
      comment:
        "`@openedbot/console/testing` (`src/pro-console/testing.ts`) sert aux tests des modules console d'un paquet pro : " +
        "aucun fichier livré de la console ne l'importe, sans quoi ses aides de test entreraient dans le bundle.",
      severity: "error",
      from: { path: "^apps/console/src/", pathNot: "^apps/console/src/pro-console/testing\\.ts$" },
      to: { path: "^apps/console/src/pro-console/testing\\.ts$" },
    },
    {
      name: "coeur-sans-staff",
      comment:
        "Le cœur n'importe jamais le backoffice ni aucun paquet pro (`@openedbot/pro-*`, plug-ins externes ; " +
        "`@openedbot/staff` avant l'étape 8) : ni ses routes, ni son mode assistance (port `ImpersonationSource` du " +
        "contrat de plug-in), ni ses tables. L'API le charge par `OPENEDBOT_PLUGINS` (`loadProPlugins`, import " +
        "dynamique), sans import statique. Plus aucune exception depuis le départ de `modules/staff`.",
      severity: "error",
      from: {},
      to: { path: "^modules/staff/|(^|/)node_modules/@openedbot/staff/|^@openedbot/staff(/|$)|(^|/)node_modules/@openedbot/pro-|^@openedbot/pro-" },
    },
    {
      name: "porte-permissions-par-le-port",
      comment:
        "Rien dans le module d'exécution ni dans le worker (la porte `permission-gate.ts`, le pipeline pur `domain/`, " +
        "le relecteur `approval-review.ts`, l'enregistrement `persist.ts`, le relais `runner.ts`) ne lit lui-même " +
        "les autorisations, les politiques d'outil, les règles en langage naturel ni l'interrupteur terminal : ces " +
        "règles passent par le port `PermissionRuleSource` (contrat de plug-in), dont la source du cœur est " +
        "`modules/execution/src/application/runner/core-permission-rules.ts` et que le plug-in `permissions` " +
        "remplace pour une organisation qui détient `permissions.v2`. Les requêtes écrites en ligne sont vues par " +
        "`tests/scripts/permission-port-contract.ts`. Seule exception : la synchronisation de la liste de blocage " +
        "côté hôte (`apps/worker/src/maintenance/approval-policy-reconciliation.ts`), qui pousse au profil Hermes " +
        "ce que le roster écrit aussi à l'enregistrement d'un bot ; elle n'est pas une décision de porte et " +
        "rejoindra le port avec les politiques d'outil du plug-in (suite de l'étape 8b).",
      severity: "error",
      from: {
        path: "^(modules/execution/src/|apps/worker/src/)",
        pathNot:
          "^modules/execution/src/application/runner/core-permission-rules\\.ts$|" +
          "^apps/worker/src/maintenance/approval-policy-reconciliation\\.ts$",
      },
      to: {
        path:
          "^modules/roster/src/sql/(permission-grants|tool-policies|permission-rules)\\.ts$|" +
          "(^|/)node_modules/@openedbot/roster/src/sql/(permission-grants|tool-policies|permission-rules)\\.ts$|" +
          "^@openedbot/roster/sql/(permission-grants|tool-policies|permission-rules)$|" +
          "^modules/runtimes/src/sql/permission-settings\\.ts$|" +
          "(^|/)node_modules/@openedbot/runtimes/src/sql/permission-settings\\.ts$|" +
          "^@openedbot/runtimes/sql/permission-settings$",
      },
    },
    {
      name: "app-sans-autre-app",
      comment: "Une application n'importe jamais le code d'une autre : ce qui se partage vit dans une couche partagée.",
      severity: "error",
      from: {
        path: "^apps/([^/]+)/(src|tests|scripts)/",
        pathNot: "^apps/api/tests/early-fanout-sse\\.test\\.ts$",
      },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-circular",
      comment:
        "Un cycle d'imports rend l'ordre d'évaluation fragile : les types seuls (`import type`) ne comptent pas.",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "contrat-api-sans-cycle",
      comment:
        "Dans contracts/api, même un cycle de types seuls est refusé : deux fichiers qui se citent l'un l'autre " +
        "appartiennent au même domaine (tests/scripts/code-structure-contract.ts tient le graphe entre dossiers).",
      severity: "error",
      from: { path: "^contracts/api/src/" },
      to: { path: "^contracts/api/src/", circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "Chaque import doit se résoudre : un chemin ou un paquet introuvable est une faute de frappe ou une dépendance non déclarée. " +
        "Hors règle : l'alias `@/` de chaque application (tsc le contrôle ; `make deps-check` le résout par application avec --ts-config), " +
        "les modules virtuels de Vite (`virtual:`) et les modules k6 (`k6`, `k6/...`).",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^(@/|virtual:|k6(/|$))" },
    },
    {
      name: "not-to-dev-dep",
      comment: "Le code livré (src/) n'importe pas une devDependency : elle manquerait en production.",
      severity: "error",
      from: { path: "^(apps|packages|platform|contracts|browser|modules)/[^/]+/src/", pathNot: TESTS },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "paquet-sans-app",
      comment: "Un paquet partagé, quelle que soit sa couche, ne dépend d'aucune application.",
      severity: "error",
      from: { path: "^(platform|contracts|browser|modules)/" },
      to: { path: "^apps/" },
    },
    {
      name: "production-sans-harnais",
      comment: "Le code livré n'importe ni les tests ni les scripts de la racine.",
      severity: "error",
      from: { path: "^(apps|platform|contracts|browser|modules)/[^/]+/src/", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^(tests|scripts)/" },
    },
    {
      name: "paquet-par-son-nom",
      comment: "Un autre paquet s'importe par son nom (@openedbot/...), jamais par un chemin relatif vers son src/.",
      severity: "error",
      from: {
        path: "^((?:apps|platform|contracts|browser|modules)/[^/]+)/",
        // The Vite config and its helpers (`vite-*.ts`): its esbuild bundle leaves package names external.
        pathNot: "^apps/(console|admin)/vite(\\.config|-[a-z-]+)\\.ts$",
      },
      to: {
        path: "^(platform|contracts|browser|modules)/",
        pathNot: "^$1/",
        dependencyTypesNot: ["aliased-workspace"],
      },
    },
    {
      name: "navigateur-sans-serveur",
      comment: "La PWA et l'admin ne chargent ni l'API, ni le worker, ni la plateforme serveur (client Hermes compris), ni les cas d'usage ou le SQL d'un module.",
      severity: "error",
      from: { path: "^apps/(console|admin)/src/", pathNot: TESTS },
      to: { path: "^(apps/(api|worker)/|platform/|modules/[^/]+/src/(application|sql)/)" },
    },
    {
      name: "navigateur-sans-node",
      comment: "Le code navigateur n'importe aucun module intégré de Node.",
      severity: "error",
      from: { path: "^apps/(console|admin)/src/", pathNot: TESTS },
      to: { dependencyTypes: ["core"] },
    },

    // Couches de l'architecture cible.
    {
      name: "contrat-sans-dependance-interne",
      comment: "Un contrat n'importe aucune autre couche du dépôt (un autre contrat, si).",
      severity: "error",
      from: { path: "^contracts/" },
      to: { path: "^(apps|platform|browser|modules|tests|scripts)/" },
    },
    {
      name: "contrat-sans-bun",
      comment: "Un contrat n'importe aucun module intégré de Bun, sauf ses tests (`bun:test`).",
      severity: "error",
      from: { path: "^contracts/", pathNot: TESTS },
      to: { path: "^bun:" },
    },
    {
      name: "contrat-sans-node",
      comment: "Un contrat est pur : aucune I/O, donc aucun module intégré de Node.",
      severity: "error",
      from: { path: "^contracts/[^/]+/src/", pathNot: "\\.test\\.tsx?$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "contrat-zod-seul",
      comment: "La seule dépendance externe d'un contrat est zod.",
      severity: "error",
      from: { path: "^contracts/[^/]+/src/", pathNot: "\\.test\\.tsx?$" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"],
        pathNot: "((^|/)node_modules/zod/|^contracts/)",
      },
    },
    {
      name: "plateforme-sans-produit",
      comment: "La plateforme ne dépend ni d'un module métier ni du code navigateur.",
      severity: "error",
      from: { path: "^platform/" },
      to: { path: "^(modules|browser)/" },
    },
    {
      name: "module-sans-navigateur",
      comment: "Un module métier importe la plateforme, les contrats et les autres modules, jamais le code navigateur.",
      severity: "error",
      from: { path: "^modules/" },
      to: { path: "^browser/" },
    },
    {
      name: "module-sans-hono",
      comment: "Un module métier ne connaît pas HTTP : hono reste dans les applications.",
      severity: "error",
      from: { path: "^modules/" },
      to: { path: "(^|/)node_modules/(hono|@hono/[^/]+)/" },
    },
    {
      name: "couche-navigateur-sans-serveur",
      comment: "Le code navigateur n'importe ni la plateforme, ni les cas d'usage ou le SQL d'un module, ni un paquet serveur, ni un module intégré de Bun.",
      severity: "error",
      from: { path: "^browser/", pathNot: TESTS },
      to: {
        path: "(^(apps|platform)/|^modules/[^/]+/src/(application|sql)/|(^|/)node_modules/(hono|pino|nodemailer|web-push)/|^bun:)",
      },
    },
    {
      name: "couche-navigateur-sans-node",
      comment: "Le code navigateur n'importe aucun module intégré de Node.",
      severity: "error",
      from: { path: "^browser/", pathNot: TESTS },
      to: { dependencyTypes: ["core"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // apps/desktop is a standalone client with its own dependencies (not a
    // Bun workspace of the core): its boundaries are not the core's.
    exclude: { path: "(^|/)(node_modules|dist|dev-dist|\\.output|\\.tanstack)/|^apps/desktop/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
