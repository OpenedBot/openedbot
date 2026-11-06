import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/**
 * Ce que la passerelle du lien exécute réellement.
 *
 * Elle porte les WebSockets des runtimes clients et n'est recréée que par
 * `make deploy-preprod-link`, qui ferme tous les liens. Chaque fichier de sa fermeture
 * d'imports est donc du code qu'une livraison ordinaire ne met pas à jour. Ce
 * test la calcule depuis `src/main.ts` (imports à l'exécution seulement, les
 * `import type` sont effacés ; les imports à effet de bord `import "x"`
 * comptent, ils exécutent tout le module) et refuse qu'un routeur produit y revienne par
 * un import de commodité : c'est ainsi que `auth.ts`, `conversation-routes.ts`
 * et `runtime-routes.ts` y étaient entrés du temps où elle vivait dans apps/api.
 *
 * Sont suivis les chemins relatifs, les paquets `@openedbot/platform-*` et les
 * modules métier (`@openedbot/<contexte>`), résolus par les `exports` de chaque
 * paquet. La passerelle ne doit atteindre ni apps/api ni aucune autre
 * application, ni un module produit : seul `@openedbot/runtime-link` est admis en
 * bloc, plus les feuilles de `@openedbot/runtimes` qu'exige l'enrôlement par le lien,
 * nommées ci-dessous. Chaque fichier de plateforme atteint est nommé lui aussi.
 */
const APP_DIR = resolve(import.meta.dir, "..");
const ENTRY = resolve(APP_DIR, "src/main.ts");
const REPO_ROOT = resolve(import.meta.dir, "../../..");

const ALLOWED_APP = [
  "apps/link-gateway/src/internal-relay.ts",
  "apps/link-gateway/src/lifecycle.ts",
  "apps/link-gateway/src/main.ts",
];

const ALLOWED_RUNTIMES = [
  // The enrollment probe's read-only client (S4), no execution verb.
  "modules/runtimes/src/application/runtime-admin-client.ts",
  "modules/runtimes/src/application/runtime-enrollment.ts",
  // The link registry, locator types and probe result the link module
  // implements, defined in runtimes since S4 (no runtimes -> runtime-link edge).
  "modules/runtimes/src/application/runtime-link-port.ts",
  // The application façades (S4) over the three SQL files below.
  "modules/runtimes/src/application/runtime-link-rows.ts",
  "modules/runtimes/src/application/runtime-probe.ts",
  "modules/runtimes/src/application/runtime-replacement.ts",
  "modules/runtimes/src/application/runtime-rows.ts",
  "modules/runtimes/src/domain/link-probe.ts",
  "modules/runtimes/src/domain/runtime-contract.ts",
  "modules/runtimes/src/sql/runtime-enrollments.ts",
  "modules/runtimes/src/sql/runtime-link-rows.ts",
  // Enrollment by the link takes the same per-organization declaration lock as
  // the API routes (single runtime per organization); SQL leaf, type-only imports.
  "modules/runtimes/src/sql/runtime-replacement.ts",
  "modules/runtimes/src/sql/runtime-rows.ts",
];

const ALLOWED_PLATFORM = [
  "platform/config/src/api-address.ts",
  "platform/config/src/api-config.ts",
  "platform/config/src/blob-driver.ts",
  "platform/config/src/connector-version.ts",
  "platform/config/src/deploy-environment.ts",
  "platform/config/src/hermes-timeouts.ts",
  "platform/config/src/http-body.ts",
  "platform/config/src/native-clients.ts",
  "platform/config/src/rate-limit.ts",
  "platform/config/src/runtime-mode.ts",
  "platform/config/src/sse-heartbeat.ts",
  "platform/db/src/credential.ts",
  "platform/db/src/db.ts",
  "platform/db/src/text-array.ts",
  // Read by api-config.ts like vapid.ts: the APNs env reader (DEV-308), no transport.
  "platform/integrations/src/apns.ts",
  "platform/integrations/src/managed-tunnel.ts",
  "platform/integrations/src/vapid.ts",
  "platform/observability/src/log/channels.ts",
  "platform/observability/src/log/context.ts",
  "platform/observability/src/log/files.ts",
  "platform/observability/src/log/redact.ts",
  "platform/observability/src/log/test-logger.ts",
  "platform/observability/src/logger.ts",
  // S7: the run's traceparent, read and journaled by the internal relay. No dependency.
  "platform/observability/src/trace-context.ts",
];

/** Le dossier d'un paquet suivi : `@openedbot/platform-<nom>` ou un module métier `@openedbot/<contexte>`. */
function followedPackageDir(name: string): string | null {
  const platform = /^@openedbot\/platform-([a-z-]+)$/.exec(name);
  if (platform) return resolve(REPO_ROOT, "platform", platform[1]!);
  const module = /^@openedbot\/([a-z-]+)$/.exec(name);
  if (module && existsSync(resolve(REPO_ROOT, "modules", module[1]!, "package.json"))) {
    return resolve(REPO_ROOT, "modules", module[1]!);
  }
  return null;
}

/** `@openedbot/<paquet>[/sous-chemin]` résolu par les `exports` du paquet, ou `null` s'il n'est pas suivi. */
function resolvePackageImport(specifier: string): string | null {
  const match = /^(@openedbot\/[a-z-]+)(\/.+)?$/.exec(specifier);
  if (!match) return null;
  const packageDir = followedPackageDir(match[1]!);
  if (!packageDir) return null;
  const manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { exports: Record<string, string> };
  const subpath = `.${match[2] ?? ""}`;
  let target = manifest.exports[subpath];
  if (!target) {
    for (const [pattern, value] of Object.entries(manifest.exports)) {
      if (!pattern.includes("*")) continue;
      const [prefix, suffix = ""] = pattern.split("*");
      if (subpath.startsWith(prefix!) && subpath.endsWith(suffix)) {
        target = value.replaceAll("*", subpath.slice(prefix!.length, suffix ? -suffix.length : undefined));
        break;
      }
    }
  }
  if (!target) throw new Error(`${specifier} n'est pas exporté par ${relative(REPO_ROOT, packageDir)}`);
  return resolve(packageDir, target);
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return resolvePackageImport(specifier);
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isTypeOnly(clause: string): boolean {
  const braces = clause.trim().match(/^\{([^}]*)\}$/);
  if (!braces) return false;
  const names = braces[1]!.split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

/** Les spécificateurs chargés à l'exécution par `source` : imports et réexports nommés, et imports à effet de bord. */
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/g)) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword || isTypeOnly(clause!)) continue;
    specifiers.push(specifier!);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

function runtimeClosure(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveImport(file, specifier);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen].map((file) => relative(REPO_ROOT, file)).sort();
}

describe("import scan", () => {
  test("follows side-effect imports, and still skips type-only ones", () => {
    const source = [
      'import "../../api/src/index";',
      'import "./side-effect"; // first',
      'import type { A } from "./a";',
      'import { type B } from "./b";',
      'import { c } from "./c";',
    ].join("\n");
    expect(runtimeSpecifiers(source).sort()).toEqual(["../../api/src/index", "./c", "./side-effect"]);
  });
});

describe("link gateway runtime closure", () => {
  const closure = runtimeClosure(ENTRY);

  test("never reaches apps/api or any other application", () => {
    expect(closure.filter((file) => file.startsWith("apps/"))).toEqual(ALLOWED_APP);
  });

  test("reaches the link module, and of the product modules only the named runtimes leaves", () => {
    const modules = closure.filter((file) => file.startsWith("modules/"));
    expect(modules.filter((file) => !file.startsWith("modules/runtime-link/src/"))).toEqual(ALLOWED_RUNTIMES);
    expect(modules.some((file) => file.startsWith("modules/runtime-link/src/"))).toBe(true);
  });

  test("reaches only the listed platform files", () => {
    expect(closure.filter((file) => file.startsWith("platform/"))).toEqual(ALLOWED_PLATFORM);
  });

  test("never loads a product router", () => {
    expect(closure.filter((file) => file.endsWith("-routes.ts") || file.endsWith("/auth.ts"))).toEqual([]);
  });
});
