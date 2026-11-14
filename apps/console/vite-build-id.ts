import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Everything the console bundle is made of. Browser code imports only
// `browser/*` and `contracts/*` besides its own app (`make deps-check`), and
// `bun.lock` pins every dependency version.
export const BUILD_INPUTS = ["apps/console", "browser", "contracts", "bun.lock", "package.json", "tsconfig.base.json"];

/**
 * The build identity, derived from the sources rather than the clock: two
 * builds of the same tree give the same id, so the same chunk hashes, and a
 * redeploy that does not touch the console keeps every browser cache. Any
 * change to a source, a dependency, the mode or a `VITE_*` value gives a new
 * id, which busts the persisted query cache.
 *
 * Tracked and untracked files both count (`-co`), so a dirty tree builds what
 * it holds; ignored files (`dist`, `node_modules`, `.env`) never do. Without
 * git (an exported tarball) the id falls back to the clock, the old behavior.
 */
export function buildId(repoRoot: string, mode: string, clientEnv: Record<string, string>): string {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...BUILD_INPUTS], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter(Boolean).sort();
  } catch {
    return Date.now().toString(36);
  }
  const hash = createHash("sha256");
  hash.update(`mode\0${mode}\0`);
  for (const key of Object.keys(clientEnv).sort()) hash.update(`env\0${key}\0${clientEnv[key]}\0`);
  for (const file of files) {
    let content: Buffer;
    try {
      content = readFileSync(join(repoRoot, file));
    } catch {
      continue; // listed by git but deleted from the working tree
    }
    hash.update(`file\0${file}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex").slice(0, 16);
}
