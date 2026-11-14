import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId } from "../../vite-build-id";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "openedbot-build-id-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "apps/console/src"), { recursive: true });
  writeFileSync(join(root, "apps/console/src/main.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".gitignore"), "dist\n");
  return root;
}

describe("console build id", () => {
  test("follows the sources, the mode and VITE_* values, never the clock or ignored files", () => {
    const root = repo();
    try {
      const id = buildId(root, "production", { VITE_API_ORIGIN: "" });
      expect(buildId(root, "production", { VITE_API_ORIGIN: "" })).toBe(id);

      mkdirSync(join(root, "apps/console/dist"));
      writeFileSync(join(root, "apps/console/dist/index.js"), "built");
      writeFileSync(join(root, "apps/admin.ts"), "outside the inputs");
      expect(buildId(root, "production", { VITE_API_ORIGIN: "" })).toBe(id);

      expect(buildId(root, "development", { VITE_API_ORIGIN: "" })).not.toBe(id);
      expect(buildId(root, "production", { VITE_API_ORIGIN: "https://api.example.com" })).not.toBe(id);
      writeFileSync(join(root, "apps/console/src/main.ts"), "export const a = 2;\n");
      expect(buildId(root, "production", { VITE_API_ORIGIN: "" })).not.toBe(id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
