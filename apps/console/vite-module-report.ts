/**
 * Writes, after a build, which source modules each output chunk carries:
 * `scripts/solo-bundle-check.ts` proves from it that a solo console holds no
 * pro screen (`make solo-check`). Off unless `OPENEDBOT_CONSOLE_MODULE_REPORT` names
 * the file; the report is written outside `dist`, never deployed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const CORE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type ModuleReport = {
  chunks: { fileName: string; name: string; bytes: number; modules: string[]; moduleBytes: Record<string, number> }[];
  assets: { fileName: string; bytes: number }[];
};

function shortId(id: string): string {
  const clean = id.replace(/^\0/, "").split("?")[0]!;
  return clean.startsWith("/") ? relative(CORE_ROOT, clean) : clean;
}

export function moduleReport(path: string | undefined): Plugin {
  return {
    name: "openedbot-module-report",
    apply: "build",
    writeBundle(_options, bundle) {
      if (!path) return;
      const report: ModuleReport = { chunks: [], assets: [] };
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          report.chunks.push({
            fileName: output.fileName,
            name: output.name,
            bytes: Buffer.byteLength(output.code),
            modules: Object.keys(output.modules).map(shortId).sort(),
            // Rendered (minified, pre-gzip) bytes per module: what the bundle budget names when it fails.
            moduleBytes: Object.fromEntries(Object.entries(output.modules).map(([id, info]) => [shortId(id), info.renderedLength])),
          });
        } else {
          report.assets.push({ fileName: output.fileName, bytes: typeof output.source === "string" ? Buffer.byteLength(output.source) : output.source.byteLength });
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    },
  };
}
