/**
 * Required plug-ins (`OPENEDBOT_REQUIRED_PLUGINS`): fail fast instead of
 * running solo by accident.
 *
 * The loader never throws: a plug-in that cannot be imported, is invalid, is
 * refused, or is dropped by the row-level-security guard is skipped and the
 * process starts solo. That is right for a core run on its own, and wrong for
 * a deployment that sells what a plug-in brings (the audit archive, the
 * reviewer): a missing package there would silently drop it. Such a
 * deployment lists the plug-in ids it needs; the API, the worker and the
 * link gateway each check them against what they finally KEPT and refuse to
 * start when one is missing. Empty or unset: no requirement.
 */
import { PLUGIN_ID_RE, type ProPlugin } from "./contract";
import type { PluginSkip } from "./loader";

export const REQUIRED_PLUGINS_ENV = "OPENEDBOT_REQUIRED_PLUGINS";

/** The required ids, deduplicated, in order. A malformed id throws: a typo must not read as "nothing required". */
export function parseRequiredPlugins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (!PLUGIN_ID_RE.test(id)) throw new Error(`${REQUIRED_PLUGINS_ENV}: ${JSON.stringify(id)} is not a plug-in id (lower case, ${PLUGIN_ID_RE}).`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The required ids that are not among the kept plug-ins. */
export function missingRequiredPlugins(required: readonly string[], kept: readonly ProPlugin[]): string[] {
  const loaded = new Set(kept.map((plugin) => plugin.manifest.id));
  return required.filter((id) => !loaded.has(id));
}

export class RequiredPluginsMissingError extends Error {
  constructor(readonly missing: readonly string[], readonly skipped: readonly PluginSkip[]) {
    const reasons = skipped.length ? ` Skipped at load: ${skipped.map((skip) => `${skip.specifier} (${skip.reason})`).join("; ")}.` : "";
    super(`${REQUIRED_PLUGINS_ENV} requires plug-in(s) that are not loaded: ${missing.join(", ")}.${reasons}`);
    this.name = "RequiredPluginsMissingError";
  }
}

/**
 * Throws `RequiredPluginsMissingError` naming every missing id (and why the
 * loader skipped what it skipped) when a required plug-in is not kept.
 */
export function assertRequiredPlugins(
  env: Readonly<Record<string, string | undefined>>,
  kept: readonly ProPlugin[],
  skipped: readonly PluginSkip[] = [],
): void {
  const missing = missingRequiredPlugins(parseRequiredPlugins(env[REQUIRED_PLUGINS_ENV]), kept);
  if (missing.length > 0) throw new RequiredPluginsMissingError(missing, skipped);
}
