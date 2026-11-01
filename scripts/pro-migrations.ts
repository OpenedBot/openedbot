/**
 * Prints the pro plug-in migration plan for `scripts/db.sh --migrate`, one
 * `<version>\t<absolute path>` line per file, from `OPENEDBOT_PLUGINS`. Skipped
 * plug-ins are reported on stderr; db.sh does not call this in solo mode.
 */
import { loadProPlugins, parsePluginList } from "../platform/plugins/src/index";
import { proMigrationPlan } from "./lib/pro-migrations";

const { plugins } = await loadProPlugins(parsePluginList(process.env.OPENEDBOT_PLUGINS), {
  warn: (skip) => console.error(`pro plug-in skipped: ${skip.specifier}: ${skip.reason}`),
});
for (const migration of proMigrationPlan(plugins)) {
  process.stdout.write(`${migration.version}\t${migration.path}\n`);
}
