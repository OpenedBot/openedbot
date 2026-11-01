/**
 * Migration plan of the pro plug-ins.
 * `scripts/db.sh --migrate` applies the core's `db/migrations` first, then
 * every file listed here, and records each as `<plug-in id>:<file>` in
 * `schema_migrations`: a plug-in migration can never collide with a core
 * version, and applied core migrations are never moved or renamed.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProPlugin } from "../../platform/plugins/src/index";

/** `NNNN_name.sql`, the same shape as the core's files; anything else is ignored. */
export const PRO_MIGRATION_FILE_RE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export type ProMigration = {
  /** `<plug-in id>:<file without .sql>`, the `schema_migrations.version` value. */
  readonly version: string;
  readonly path: string;
};

export function proMigrationVersion(pluginId: string, file: string): string {
  return `${pluginId}:${file.replace(/\.sql$/, "")}`;
}

/**
 * Plug-ins in load order, each plug-in's files sorted by name. Plug-ins
 * without `migrations` contribute nothing; a missing directory is an error,
 * because a plug-in that ships migrations but lost them must not boot on a
 * schema it expects.
 */
export function proMigrationPlan(
  plugins: readonly ProPlugin[],
  list: (directory: string) => readonly string[] = (directory) => readdirSync(directory),
): ProMigration[] {
  const plan: ProMigration[] = [];
  for (const plugin of plugins) {
    if (!plugin.migrations) continue;
    const files = list(plugin.migrations.directory).filter((file) => PRO_MIGRATION_FILE_RE.test(file)).sort();
    for (const file of files) {
      plan.push({ version: proMigrationVersion(plugin.manifest.id, file), path: join(plugin.migrations.directory, file) });
    }
  }
  return plan;
}
