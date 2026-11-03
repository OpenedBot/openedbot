import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * edge-setup, the host tool (Go), lives in edge-setup/ of this monorepo
 * (OpenedBot/openedbot) unless EDGE_SETUP_DIR
 * says otherwise. The link contract and the approval-policy twins read its
 * sources: a missing checkout fails loudly instead of skipping the comparison.
 */
export const EDGE_SETUP_DIR = resolve(process.env.EDGE_SETUP_DIR ?? join(import.meta.dir, "../edge-setup"));

export function edgeSetupPath(relative: string): string {
  const path = join(EDGE_SETUP_DIR, relative);
  if (!existsSync(path)) {
    throw new Error(`edge-setup not found at ${path}: expected edge-setup/ in this repository, or set EDGE_SETUP_DIR`);
  }
  return path;
}
