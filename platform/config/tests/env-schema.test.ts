import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPRECATED_ENV_NAMES,
  ENV_SCHEMA,
  ENV_DIRS,
  ENV_SCHEMA_BY_NAME,
  envFilePath,
  isDeprecatedEnvName,
  envNamesOfTier,
  envUnusedForRuntimeMode,
  localTemplateEntries,
  productionTemplateEntries,
  requiredEnvNames,
} from "../src/env-schema";

/**
 * A3: one source of truth for the environment.
 *
 * Static test (no PostgreSQL, no network): every variable a config file, the
 * setup script or the Makefile reads must be declared in ENV_SCHEMA, and the
 * committed templates must be exactly what the schema generates. Comments
 * are stripped before scanning so that a variable merely mentioned in prose
 * does not pass for a read.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** `env.NAME` and `process.env.NAME` in TypeScript sources. */
const TS_ENV_READ = /\benv\.([A-Z][A-Z0-9_]+)\b/gu;
/** `import.meta.env.NAME` in Vite-bundled TypeScript sources. */
const IMPORT_META_ENV_READ = /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)\b/gu;
/** `required("NAME")` / `positiveInteger("NAME", ...)` string-literal reads (apps/api/src/alerting/index.ts). */
const HELPER_LITERAL_READ = /\b(?:required|positiveInteger)\(\s*"([A-Z][A-Z0-9_]+)"/gu;
/** `${NAME}` / `$NAME` in shell scripts, filtered through ENV_READ_SKIP below. */
const SHELL_ENV_READ = /\$\{?([A-Z][A-Z0-9_]*)\}?/gu;
/** `set_env_value NAME` in scripts/setup.sh. */
const SETUP_WRITE = /\bset_env_value\s+([A-Z][A-Z0-9_]+)\b/gu;
/** `NAME="$(...)"` / `NAME="$$..."` exported to a child command in the Makefile. */
const MAKEFILE_EXPORT = /\b([A-Z][A-Z0-9_]+)="\$/gu;

/**
 * Well-known OS/CLI/shell names that are not openedbot configuration: a script
 * reading `$HOME` or `$PATH`, or a logger honoring `NO_COLOR`, is not a gap in
 * ENV_SCHEMA. Positional and local shell variables never match (they are not
 * upper-case with an underscore, or start with a digit).
 */
const ENV_READ_SKIP = new Set([
  "HOME", "PATH", "PWD", "TMPDIR", "USER", "SHELL", "RANDOM", "NO_COLOR", "TERM",
  "EDITOR", "PAGER", "LANG", "LC_ALL", "IFS", "OLDPWD", "PPID", "UID", "EUID",
  "HOSTNAME", "LINES", "COLUMNS",
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/^[ \t]*\/\/[^\n]*/gmu, (line) => " ".repeat(line.length));
}

function stripShellComments(source: string): string {
  return source.replace(/^[ \t]*#[^\n]*/gmu, (line) => " ".repeat(line.length));
}

function referencedNames(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]!))].sort();
}

function readRepoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

function templateNames(relative: string): string[] {
  return readRepoFile(relative)
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((name): name is string => Boolean(name));
}

const SCANNED: ReadonlyArray<{ path: string; pattern: RegExp; strip: (source: string) => string; label?: string; skip?: ReadonlySet<string> }> = [
  { path: "platform/config/src/api-config.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "apps/worker/src/config.ts", pattern: TS_ENV_READ, strip: stripComments },
  // Les passes navigateur lisent l'environnement elles aussi. Sans elles dans
  // cette liste, E2E_ORIGIN / E2E_PHONE_* ont vécu hors du schéma.
  { path: "apps/console/scripts/pwa-mobile-pass.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "apps/console/scripts/pwa-chromium-pass.ts", pattern: TS_ENV_READ, strip: stripComments },
  // Les configs Vite et leur socle lisent l'environnement avant l'app : c'est
  // de là que viennent le port des clients et la cible de proxy.
  { path: "platform/config/src/client-env.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "apps/console/vite.config.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "scripts/setup.sh", pattern: SETUP_WRITE, strip: stripShellComments },
  { path: "Makefile", pattern: MAKEFILE_EXPORT, strip: stripShellComments },
  // Élargissement de l'audit A3 : ces lecteurs manquaient à l'appel, ce qui a
  // laissé HERMES_SESSION_MESSAGES_TIMEOUT_MS, LINK_DEV_*, OPENEDBOT_POSTGRES_PORT
  // et les confirmations de reset hors du schéma pendant que MIGRATOR_DATABASE_URL
  // et les NEXT_PUBLIC_* survivaient sans plus aucun lecteur.
  { path: "apps/api/src/alerting/index.ts", pattern: TS_ENV_READ, strip: stripComments },
  {
    path: "apps/api/src/alerting/index.ts",
    pattern: HELPER_LITERAL_READ,
    strip: stripComments,
    label: "required()/positiveInteger() literals",
  },
  { path: "apps/api/src/index.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/observability/src/logger.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "modules/runtime-link/src/application/config.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "apps/api/scripts/dev-reset-data.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/config/src/hermes-timeouts.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/hermes/src/mtls.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/integrations/src/managed-tunnel.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/integrations/src/vapid.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "platform/integrations/src/apns.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "scripts/lib/link-dev.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "scripts/link-dev.ts", pattern: TS_ENV_READ, strip: stripComments },
  { path: "scripts/db.sh", pattern: SHELL_ENV_READ, strip: stripShellComments },
  { path: "apps/console/src/lib/api/http.ts", pattern: IMPORT_META_ENV_READ, strip: stripComments },
];

describe("ENV_SCHEMA: single source of truth for the environment", () => {
  test("names are unique and well-formed", () => {
    const names = ENV_SCHEMA.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    for (const entry of ENV_SCHEMA) expect(entry.doc, `${entry.name} doc must be one line`).not.toContain("\n");
  });

  for (const { path, pattern, strip, label, skip } of SCANNED) {
    test(`every variable read in ${path}${label ? ` (${label})` : ""} is declared`, () => {
      const names = referencedNames(strip(readRepoFile(path)), pattern).filter((name) => !ENV_READ_SKIP.has(name) && !skip?.has(name));
      expect(names.length, `${path}: the pattern must still find reads`).toBeGreaterThan(0);
      const undeclared = names.filter((name) => !ENV_SCHEMA_BY_NAME.has(name));
      expect(undeclared, `${path} reads variables missing from ENV_SCHEMA`).toEqual([]);
    });
  }

  // Un seul fichier pour le monorepo (ENV_DIR_OF_SCOPE) : le .env.example de
  // la racine doit contenir exactement les variables `local` du schéma, ni
  // plus, ni moins. C'est ce qui garantit qu'aucune valeur n'est énoncée deux
  // fois. La boucle reste écrite sur ENV_DIRS : elle tiendra encore si une
  // portée reprenait un jour son propre fichier.
  test("each .env.example holds exactly the local variables of its workspace", () => {
    for (const dir of ENV_DIRS) {
      const path = envFilePath(dir, ".env.example");
      const names = templateNames(path);
      expect(new Set(names).size, `${path} has duplicates`).toBe(names.length);
      expect(names, `${path} does not match the schema`)
        .toEqual(localTemplateEntries(dir).map(({ entry }) => entry.name));
    }
  });

  test("no variable is listed in two .env.example files", () => {
    const seen = new Map<string, string>();
    for (const dir of ENV_DIRS) {
      const path = envFilePath(dir, ".env.example");
      for (const name of templateNames(path)) {
        expect(seen.get(name), `${name} is in both ${seen.get(name)} and ${path}`).toBeUndefined();
        seen.set(name, path);
      }
    }
    expect([...seen.keys()].sort()).toEqual(localTemplateEntries().map(({ entry }) => entry.name).sort());
  });

  /**
   * L'invariant de la consolidation : plus AUCUN fichier d'environnement à
   * côté d'une application. Il ne suffit pas de les avoir supprimés : Bun
   * charge `.env.local` du dossier courant et Vite ceux de son `envDir` : un
   * fichier réapparu serait lu en silence, et sa valeur écraserait celle de la
   * racine sans qu'aucun contrôle ne le dise.
   */
  test("no application carries an env file of its own any more", async () => {
    const strays = (
      await Promise.all(
        ["api", "worker", "console", "admin"].flatMap((app) =>
          [".env", ".env.local", ".env.example"].map(async (name) => {
            const path = `apps/${app}/${name}`;
            return (await Bun.file(join(REPO_ROOT, path)).exists()) ? path : null;
          }),
        ),
      )
    ).filter((path) => path !== null);
    expect(strays, "these files are loaded silently by Bun or Vite").toEqual([]);
  });

  /**
   * Un nom obsolète a quitté le schéma, mais pas le nettoyage : il ne doit ni
   * réapparaître comme entrée (le modèle le proposerait de nouveau), ni cesser
   * d'être effacé d'un `.env.local` ancien (un inconnu est conservé tel quel,
   * pas supprimé).
   */
  test("a deprecated name has left the schema but is still pruned", () => {
    for (const name of DEPRECATED_ENV_NAMES) {
      expect(ENV_SCHEMA_BY_NAME.has(name), `${name} is declared again`).toBe(false);
      expect(isDeprecatedEnvName(name), `${name} would survive make env-prune`).toBe(true);
    }
  });

  test("no default_only variable appears in a .env.example", () => {
    for (const dir of ENV_DIRS) {
      const path = envFilePath(dir, ".env.example");
      const misplaced = templateNames(path)
        .filter((name) => ENV_SCHEMA_BY_NAME.get(name)?.tier !== "local");
      expect(misplaced, `${path} lists non-local variables`).toEqual([]);
    }
  });

  // No production file is committed: deployment values are secret-manager
  // owned, and a committed copy could only drift from the schema. The
  // generation itself still has to hold, so that `make env-prod-list` keeps
  // printing every production variable exactly once.
  test("no production template is committed", () => {
    expect(existsSync(join(REPO_ROOT, ".env.production.example"))).toBe(false);
  });

  test("the production template generates every production variable, exactly once", () => {
    const names = productionTemplateEntries().map(({ entry }) => entry.name);
    expect(new Set(names).size, "the production template has duplicates").toBe(names.length);
    for (const name of envNamesOfTier("production")) {
      expect(names, `${name} is a production variable and must be printed`).toContain(name);
    }
    for (const { entry } of productionTemplateEntries()) {
      expect(entry.tier === "production" || entry.productionExample !== undefined).toBe(true);
    }
  });

  test("required sets keep the external runtime semantics", () => {
    expect(requiredEnvNames("development", "external").sort()).toEqual([
      "API_DATABASE_URL", "BLOB_DRIVER", "RUNTIME_TOKEN_ENCRYPTION_KEY", "WORKER_DATABASE_URL",
    ]);
    expect(requiredEnvNames("production").sort()).toEqual([
      "ALERT_WEBHOOK_URL", "API_DATABASE_URL", "API_PUBLIC_URL", "AUDIT_VERDICT_SIGNING_KEY",
      "AUDIT_WORM_BUCKET", "AUDIT_WORM_ENDPOINT", "AUDIT_WORM_MODE", "AUDIT_WORM_READ_ACCESS_KEY_ID", "AUDIT_WORM_READ_SECRET_ACCESS_KEY",
      "AUDIT_WORM_WRITE_ACCESS_KEY_ID", "AUDIT_WORM_WRITE_SECRET_ACCESS_KEY",
      "BLOB_DRIVER", "FILES_CDN_SIGNING_KEY",
      "FILES_CDN_URL", "METRICS_INTERNAL_TOKEN", "OHB_RUNTIME_ADMIN_MODE",
      "PUSH_VAPID_PRIVATE_KEY", "PUSH_VAPID_PUBLIC_KEY", "PUSH_VAPID_SUBJECT",
      "R2_ACCESS_KEY_ID", "R2_BUCKET", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY", "RUNTIME_TOKEN_ENCRYPTION_KEY",
      "TRANSACTIONAL_EMAIL_FROM", "WEB_APP_URL", "WORKER_DATABASE_URL",
      "WORKER_INTERNAL_TOKEN",
    ]);
    expect(requiredEnvNames("test")).toEqual([]);
  });

  // The seed reads DEV_HERMES_URL / DEV_HERMES_TOKEN only under the fake
  // profile, which runs in runtime mode `external` like a real external host
  // that registers its runtime through the application. No (environment,
  // runtime mode) pair can therefore require them: `make env-check` must
  // accept an external `.env.local` without them.
  test("the seed-only Hermes variables are never required", () => {
    const seedOnly = ["DEV_HERMES_TOKEN", "DEV_HERMES_URL"];
    for (const environment of ["development", "test", "production"] as const) {
      for (const runtimeMode of ["external", undefined] as const) {
        const required = requiredEnvNames(environment, runtimeMode);
        expect(required.filter((name) => seedOnly.includes(name)), `${environment}/${runtimeMode ?? "any"}`).toEqual([]);
      }
    }
    for (const name of seedOnly) expect(ENV_SCHEMA_BY_NAME.get(name)?.tier).toBe("local");
  });

  test("external mode has no obsolete mode-specific variables", () => {
    expect([...envUnusedForRuntimeMode("external")].sort()).toEqual([]);
  });

  test("bun scripts/env.ts --template --check passes", () => {
    const result = Bun.spawnSync(["bun", "scripts/env.ts", "--template", "--check"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});

describe("ENV_SCHEMA_PATTERNS: plug-in variables", () => {
  test("isCoreEnvName: a declared, family or retired name is the core's; a plug-in's own deploy name is not (step 11.5)", async () => {
    const { isCoreEnvName } = await import("../src/env-schema");
    for (const name of ["API_DATABASE_URL", "BILLING_PRICE_EUR", "OPENEDBOT_PLUGINS", "OPENEDBOT_PLUGIN_BILLING__API_KEY", "WEB_ORIGINS"]) {
      expect(isCoreEnvName(name), name).toBe(true);
    }
    for (const name of ["PAY_SECRET_KEY", "PROVIDER_WEBHOOK_SECRET"]) expect(isCoreEnvName(name), name).toBe(false);
  });

  test("the core schema names no payment provider variable (step 11.5)", async () => {
    const { ENV_SCHEMA } = await import("../src/env-schema");
    const provider = "stripe";
    expect(ENV_SCHEMA.filter((entry) => `${entry.name} ${entry.doc}`.toLowerCase().includes(provider)).map((entry) => entry.name)).toEqual([]);
  });

  test("OPENEDBOT_PLUGIN_<ID>__<KEY> is declared, secret, default_only, owned by the API", async () => {
    const { envSchemaEntry, envDirOfName } = await import("../src/env-schema");
    for (const name of ["OPENEDBOT_PLUGIN_BILLING__API_KEY", "OPENEDBOT_PLUGIN_AGENCY__MAX_CLIENTS", "OPENEDBOT_PLUGIN_PLUGIN_REPORTS__X1"]) {
      const entry = envSchemaEntry(name);
      expect(entry?.name).toBe(name);
      expect(entry?.tier).toBe("default_only");
      expect(entry?.secret).toBe(true);
      expect(envDirOfName(name)).toBe(envDirOfName("OPENEDBOT_PLUGINS"));
    }
  });

  test("the plug-in list stays a named variable; malformed OPENEDBOT_PLUGIN_* names are flagged", async () => {
    const { envSchemaEntry, isMalformedPluginEnvName } = await import("../src/env-schema");
    expect(envSchemaEntry("OPENEDBOT_PLUGINS")?.tier).toBe("default_only");
    expect(isMalformedPluginEnvName("OPENEDBOT_PLUGINS")).toBe(false);
    expect(isMalformedPluginEnvName("OPENEDBOT_PLUGIN_BILLING__API_KEY")).toBe(false);
    for (const name of ["OPENEDBOT_PLUGIN_BILLING_API_KEY", "OPENEDBOT_PLUGIN_BILLING__", "OPENEDBOT_PLUGIN_BILLING__key", "OPENEDBOT_PLUGIN_BILLING__A_", "OPENEDBOT_PLUGIN_X__KEY"]) {
      expect(isMalformedPluginEnvName(name), name).toBe(true);
    }
    expect(isMalformedPluginEnvName("API_DATABASE_URL")).toBe(false);
  });

  test("the audit plug-in variables are documented: retention for the worker, anchoring grants for the API", async () => {
    const { envSchemaEntry, envDirOfName, isMalformedPluginEnvName } = await import("../src/env-schema");
    const retention = envSchemaEntry("OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS");
    expect(retention?.scope).toBe("worker");
    expect(retention?.tier).toBe("default_only");
    expect(retention?.secret).toBeUndefined();
    expect(retention?.doc).toContain("Unset");
    expect(envDirOfName("OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS")).toBe(".");
    expect(envSchemaEntry("OPENEDBOT_PLUGIN_AUDIT__ANCHOR_ORGANIZATIONS")?.scope).toBe("api");
    expect(isMalformedPluginEnvName("OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS")).toBe(false);
    // Any other audit key still falls in the generic, secret family.
    expect(envSchemaEntry("OPENEDBOT_PLUGIN_AUDIT__OTHER")?.secret).toBe(true);
  });

  test("a plug-in variable never enters a template", () => {
    const names = ENV_SCHEMA.map((entry) => entry.name);
    expect(names.some((name) => /^OPENEDBOT_PLUGIN_.+__/.test(name))).toBe(false);
  });
});
