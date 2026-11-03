import {
  ENV_DIRS,
  envFilePath,
  envSchemaEntry,
  envUnusedForRuntimeMode,
  isDeprecatedEnvName,
} from "../../platform/config/src/env-schema";
import { foldEnvMerges, mergedEnvTarget, renamedEnvName } from "../../platform/config/src/legacy-env";
import type { RuntimeMode } from "@openedbot/contracts-api";

/** Helpers shared by env-audit and env-template. Values are never printed. */

export type EnvEntry = { name: string; value: string };

export function parseEnvLine(line: string): EnvEntry | null {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  return match ? { name: match[1]!, value: match[2]! } : null;
}

export function parseEnvEntries(text: string): EnvEntry[] {
  return text.split(/\r?\n/).map(parseEnvLine).filter((entry): entry is EnvEntry => entry !== null);
}

export async function readEnvNames(path: string): Promise<string[]> {
  return parseEnvEntries(await Bun.file(path).text()).map((entry) => entry.name);
}

export function assertUniqueEnvNames(path: string, names: readonly string[]): void {
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`${path} contains duplicate variables: ${[...new Set(duplicates)].join(", ")}`);
}

/**
 * What `env-audit --apply` does with one `.env.local` entry.
 *
 *   - `rename`: an old OHB_* name of the OPENEDBOT_* rename, rewritten under
 *     its new name with its value (removed when the new name is already set);
 *   - `remove`: deprecated, unused in this runtime mode, or an empty non-local variable;
 *   - `preserve`: a non-empty production / default-only variable, reported
 *     by name but kept;
 *   - `keep`: a local variable, or one unknown to the schema.
 */
export type LocalEnvDecision = "keep" | "preserve" | "remove" | "rename";

export function classifyLocalEnvEntry(entry: EnvEntry, runtimeMode: RuntimeMode): LocalEnvDecision {
  if (renamedEnvName(entry.name) || mergedEnvTarget(entry.name)) return "rename";
  if (isDeprecatedEnvName(entry.name) || envUnusedForRuntimeMode(runtimeMode).has(entry.name)) return "remove";
  const tier = envSchemaEntry(entry.name)?.tier;
  if (tier !== "production" && tier !== "default_only") return "keep";
  return entry.value.trim() ? "preserve" : "remove";
}

/** One env file of the monorepo, as read from disk. */
export type EnvFile = { dir: string; path: string; text: string; entries: EnvEntry[] };

/** Every existing env file of the given name, root first. */
export async function readEnvFiles(fileName: string): Promise<EnvFile[]> {
  const files: EnvFile[] = [];
  for (const dir of ENV_DIRS) {
    const path = envFilePath(dir, fileName);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const text = await file.text();
    files.push({ dir, path, text, entries: parseEnvEntries(text) });
  }
  return files;
}

/**
 * The union of the files, and where each name came from.
 *
 * The whole point of splitting by workspace is that a value is stated once.
 * A name present in two files is therefore an error, not a precedence
 * question: silently letting one win is how the two copies drift apart.
 */
export function mergeEnvFiles(files: readonly EnvFile[]): {
  values: Record<string, string>;
  sourceOf: Map<string, string>;
} {
  const values: Record<string, string> = {};
  const sourceOf = new Map<string, string>();
  for (const file of files) {
    assertUniqueEnvNames(file.path, file.entries.map((entry) => entry.name));
    for (const entry of file.entries) {
      const previous = sourceOf.get(entry.name);
      if (previous) {
        throw new Error(`${entry.name} is declared in both ${previous} and ${file.path}; it must live in exactly one file.`);
      }
      sourceOf.set(entry.name, file.path);
      values[entry.name] = entry.value;
    }
  }
  return { values, sourceOf };
}

/**
 * The values with every old OHB_* name folded into its OPENEDBOT_* name
 * (when that one is absent), then the merged names converted (ENV_MERGES):
 * what the file holds once `env-audit --apply` has rewritten it.
 */
export function withRenamedEnvValues(values: Readonly<Record<string, string>>, options: { merges?: boolean } = {}): Record<string, string> {
  const folded: Record<string, string> = { ...values };
  for (const [name, value] of Object.entries(values)) {
    const next = renamedEnvName(name);
    if (!next) continue;
    if (!(next in values)) folded[next] = value;
    delete folded[name];
  }
  const merged: Record<string, string | undefined> = folded;
  if (options.merges !== false) foldEnvMerges(merged);
  return merged as Record<string, string>;
}
