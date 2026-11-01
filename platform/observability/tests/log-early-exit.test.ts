import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = join(import.meta.dir, "../src/log/files.ts");

describe("a process that exits right after opening the log files", () => {
  test("exits cleanly, its line already on disk", async () => {
    // Before: the file was opened asynchronously, and pino's exit flush threw
    // « sonic boom is not ready yet » (exit 1 for a test that meant to skip).
    const dir = mkdtempSync(join(tmpdir(), "ohb-log-exit-"));
    try {
      const script = `
        import pino from "pino";
        import { createLogFileStream } from ${JSON.stringify(FILES)};
        const logger = pino({}, createLogFileStream({ dir: ${JSON.stringify(dir)}, env: "probe" }));
        logger.info({ channel: "app" }, "early exit probe");
        process.exit(0);
      `;
      const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "..") });
      const code = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(stderr).not.toContain("sonic boom is not ready");
      expect(code).toBe(0);
      expect(readFileSync(join(dir, "probe.log"), "utf8")).toContain("early exit probe");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
