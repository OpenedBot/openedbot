/**
 * Ownership of execution, offline (`make test-unit`). ADR 0001 (S3), section 4.6.
 *
 * The API reads and administers a runtime synchronously; it never executes a
 * turn on it. A mutation of execution (a session, a run, its stream, its
 * approvals, steering, stopping it) is a durable command the worker executes
 * under a lease (`modules/execution/src/application/execution-commands.ts`).
 *
 * Strict:
 *
 *  1. In the API (`apps/api/src`, `apps/api/scripts`, tests excluded), no
 *     `new HermesClient`: the only client is `runtimeAdminClient`
 *     (`FACTORY`), whose type and proxy have no execution verb. No call of an
 *     execution verb, no import of the worker's client
 *     (`execution/application/runtime-client`), no import of an execution
 *     entry point (`ENTRY_POINTS`: the room summary, a run, a command).
 *  2. In `modules/*\/src` and `platform/*\/src`, `new HermesClient` only in
 *     the files of `CONSTRUCTORS`, each with its class: the two factories
 *     (`runtimeAdminClient`, the worker's `createRuntimeClient`) and the
 *     client itself. Since S4 the roster's bot host and the link enrollment
 *     probe go through `runtimeAdminClient` too; a new constructor is
 *     classified here (read/admin or execution) before it ships.
 *  3. Every public method of `HermesClient` is classified: one of
 *     `RUNTIME_EXECUTION_VERBS` (parsed from `FACTORY`) or one of
 *     `ADMIN_VERBS` below. A new method fails until it is; a verb of the
 *     factory that `HermesClient` no longer has fails too (renamed, the
 *     guard would protect nothing).
 *
 * Comments are blanked before matching.
 *
 *   bun tests/scripts/runtime-client-contract.ts [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? "." : resolve(import.meta.dir, "../.."));

const FACTORY = "modules/runtimes/src/application/runtime-admin-client.ts";
const CLIENT = "platform/hermes/src/client.ts";

/** Where `new HermesClient` may appear outside the API, and why. */
const CONSTRUCTORS: Record<string, string> = {
  [FACTORY]: "read/admin : le seul client de l'API, sans verbe d'exécution",
  [CLIENT]: "le client lui-même (son profil dérivé)",
  "modules/execution/src/application/runtime-client.ts": "exécution : le client du worker, sous le bail du run ou de la commande",
};

/** The reads and administration of a runtime; `RUNTIME_EXECUTION_VERBS` holds the rest. */
const ADMIN_VERBS = new Set([
  "health", "capabilities", "probe", "runSteerSupported", "probeProfileIsolation", "models", "modelOptions",
  "hostCapabilities", "hostProviderSdks", "a2aAgentCard", "a2aAudit", "a2aPolicy", "a2aTrustPeer", "a2aSetPeerToken",
  "a2aDeletePeerToken", "providerUsage", "modelContext", "providerCredentialAdd", "providerOauthStart",
  "providerOauthPoll", "providerOauthCancel", "hostToolsets", "hostSkills", "hostProfileInventory", "hostProfileAvatar",
  "hostWorkspaceFile", "hostCreateProfile", "hostSetProfileModel", "hostSetProfileModels", "hostDeleteProfile",
  "hostSetProfileToolset", "hostSetProfileToolsets", "hostApprovalPolicy", "hostSetApprovalPolicy", "hostProfileMemory",
  "hostWriteProfileMemory", "hostSetProfileMcpServer", "hostRemoveProfileMcpServer", "hostSetProfileSkill",
  "hostSetProfileBundledSkills", "skillsHubSearch", "skillsHubInspect", "skillsHubScan", "skillsHubInstall",
  "skillsHubOperation", "hostDeleteProfileSkill", "hostSetProfileCredential", "hostDeleteProfileCredential",
  "toolsetSet", "mcpInventory", "mcpServerAdd", "mcpCatalogInstall", "mcpOauthStart", "mcpOauthPoll",
  "mcpOauthCallback", "mcpOauthCancel", "gatewayStatus", "gatewayRestart", "gatewayRestartPoll", "mcpServerRemove",
  "capabilityInventory", "browserControlTransportProbe", "connectorManagementProbe", "toolsets", "cachedToolsets",
  // Session housekeeping (usage counters, purge of a deleted bot), not a turn.
  "sessionCounters", "sessionMessages", "deleteSession", "removeSession",
  // Preflight reads of the stream feature, answered from the cache or `/v1/capabilities`.
  "eventReplaySupported", "peekCachedEventReplay",
]);

/** What starts or drives execution: the API reaches none of them directly. */
const ENTRY_POINTS = ["compactThreadNow", "compactRoomThread", "runThreadCompaction", "executeRun", "executeExecutionCommand", "createRuntimeClient"];

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "tests" && entry !== "test") walk(path, out);
    } else if (/\.tsx?$/u.test(entry) && !/\.(test|bench)\.tsx?$|\.d\.ts$/u.test(entry)) {
      out.push(path);
    }
  }
}

function files(...dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) walk(join(root, dir), out);
  return out.map((file) => relative(root, file)).sort();
}

function packages(layer: string): string[] {
  const base = join(root, layer);
  if (!existsSync(base)) return [];
  return readdirSync(base).map((pkg) => `${layer}/${pkg}/src`);
}

/** Comments blanked, newlines kept, so that line numbers stay those of the file. */
function code(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/gu, " ");
  return text.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/^[ \t]*\/\/.*$/gmu, blank);
}

const line = (text: string, index: number) => text.slice(0, index).split("\n").length;
const read = (file: string) => code(readFileSync(join(root, file), "utf8"));

const errors: string[] = [];

// 3. Classification of HermesClient's verbs.
const executionVerbs: string[] = [];
if (!existsSync(join(root, FACTORY))) {
  errors.push(`${FACTORY} est introuvable : la fabrique du client de l'API a disparu ou a été déplacée sans mettre ce contrat à jour.`);
} else {
  const list = read(FACTORY).match(/RUNTIME_EXECUTION_VERBS\s*=\s*\[([\s\S]*?)\]/u);
  if (!list) errors.push(`${FACTORY} : RUNTIME_EXECUTION_VERBS introuvable.`);
  else executionVerbs.push(...[...list[1]!.matchAll(/"(\w+)"/gu)].map((match) => match[1]!));
}
if (existsSync(join(root, CLIENT))) {
  const text = read(CLIENT);
  const body = text.match(/export class HermesClient \{([\s\S]*?)\n\}/u)?.[1] ?? "";
  const methods = new Set([...body.matchAll(/^ {2}(?:async )?([A-Za-z0-9]+)\(/gmu)].map((match) => match[1]!).filter((name) => name !== "constructor"));
  for (const method of methods) {
    if (!executionVerbs.includes(method) && !ADMIN_VERBS.has(method)) {
      errors.push(`${CLIENT} : HermesClient.${method} n'est classé ni en exécution (RUNTIME_EXECUTION_VERBS de ${FACTORY}) ni en lecture/administration (ADMIN_VERBS de ce contrat). Classez-le avant de le livrer.`);
    }
  }
  for (const verb of executionVerbs) {
    if (!methods.has(verb)) errors.push(`${FACTORY} : « ${verb} » n'est plus une méthode de HermesClient ; la garde ne protège plus ce verbe (renommé ?).`);
  }
} else {
  errors.push(`${CLIENT} est introuvable.`);
}

// 1. The API.
const verbCall = executionVerbs.length ? new RegExp(`\\.(${executionVerbs.join("|")})\\s*\\(`, "gu") : null;
const entryImport = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b(${ENTRY_POINTS.join("|")})\\b[^}]*\\}\\s+from`, "gu");
for (const file of files("apps/api/src", "apps/api/scripts")) {
  const text = read(file);
  for (const match of text.matchAll(/\bnew\s+HermesClient\b/gu)) {
    errors.push(`${file}:${line(text, match.index)} : « new HermesClient » dans l'API. Lecture ou administration : runtimeAdminClient (${FACTORY}). Exécution : une commande durable du worker (execution-commands).`);
  }
  if (verbCall) {
    for (const match of text.matchAll(verbCall)) {
      errors.push(`${file}:${line(text, match.index)} : appel du verbe d'exécution « ${match[1]} » dans l'API ; il appartient au worker, sous bail.`);
    }
  }
  for (const match of text.matchAll(/@openedbot\/execution\/application\/runtime-client\b/gu)) {
    errors.push(`${file}:${line(text, match.index)} : l'API importe le client du worker (execution/application/runtime-client).`);
  }
  for (const match of text.matchAll(entryImport)) {
    errors.push(`${file}:${line(text, match.index)} : l'API importe « ${match[1]} », un point d'entrée de l'exécution ; enregistrez une commande durable à la place.`);
  }
}

// 2. Modules and platform.
for (const file of files(...packages("modules"), ...packages("platform"))) {
  if (file in CONSTRUCTORS) continue;
  const text = read(file);
  for (const match of text.matchAll(/\bnew\s+HermesClient\b/gu)) {
    errors.push(`${file}:${line(text, match.index)} : « new HermesClient » hors des fabriques classées de ce contrat (CONSTRUCTORS). Passez par runtimeAdminClient (lecture, administration) ou createRuntimeClient (worker), ou classez ce fichier.`);
  }
}

for (const message of errors) console.error(`runtime-client-contract: ${message}`);
if (errors.length) process.exit(1);
console.log(`runtime-client-contract: l'API ne crée que des clients de lecture et d'administration (${FACTORY}) ; ${executionVerbs.length} verbes d'exécution réservés au worker.`);
