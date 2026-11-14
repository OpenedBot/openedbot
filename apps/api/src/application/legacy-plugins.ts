/**
 * Legacy install: plug-ins the API would install itself, without
 * `OPENEDBOT_PLUGINS`, resolved from `apps/api`'s own dependencies. Empty since
 * step 8: every pro plug-in loads through `OPENEDBOT_PLUGINS`.
 *
 * The mechanism stays for a later move that has to keep serving a feature
 * during the switch: a legacy plug-in absent from the image is skipped with a
 * warning, and one that `OPENEDBOT_PLUGINS` already loaded (same id) is not
 * installed twice.
 */
import { loadProPlugins, type PluginSkip, type ProPlugin } from "@openedbot/platform-plugins";

export const LEGACY_PLUGIN_SPECIFIERS: readonly string[] = [];

export type LegacyPluginWarnings = {
  skipped?: (skip: PluginSkip) => void;
  superseded?: (event: { pluginId: string; specifier: string }) => void;
};

export async function loadLegacyPlugins(
  loaded: readonly ProPlugin[],
  warnings: LegacyPluginWarnings = {},
  specifiers: readonly string[] = LEGACY_PLUGIN_SPECIFIERS,
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<readonly ProPlugin[]> {
  const installed: ProPlugin[] = [];
  for (const specifier of specifiers) {
    const { plugins } = await loadProPlugins([specifier], { importer, warn: warnings.skipped });
    for (const plugin of plugins) {
      const id = plugin.manifest.id;
      if (loaded.some((other) => other.manifest.id === id) || installed.some((other) => other.manifest.id === id)) {
        warnings.superseded?.({ pluginId: id, specifier });
        continue;
      }
      installed.push(plugin);
    }
  }
  return installed;
}

