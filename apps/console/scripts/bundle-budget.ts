/**
 * `make bundle-budget`: what a solo console build makes a launch download,
 * held under the budgets of ADR 0001 (G2, section 3), gzip-measured.
 *
 *   bun apps/console/scripts/bundle-budget.ts <dist> <report.json>
 *
 *   - entry: the chunk `index.html` runs (`<script type="module">`);
 *   - first load: every script `index.html` loads or preloads, plus the
 *     largest language dictionary (`vite-locale-preload.ts` preloads one;
 *     the largest is the worst case).
 *
 * The route a launch lands on adds its own chunk (home, conversation): the
 * replayable measure of everything before the thread list is
 * `apps/console/scripts/perf/d0-baseline.ts` (G2 "until marker"). The first
 * load budget sits below the G2 target to leave the route that room.
 *
 * On failure, the largest modules of the first load are named, from the
 * module report (`vite-module-report.ts`, rendered pre-gzip bytes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** gzip ko. Raising one is a decision: re-measure G2 with the D0 script and record it in the ADR. */
export const BUDGET_KB = { entry: 200, firstLoad: 380 } as const;

type Report = { chunks: { fileName: string; moduleBytes: Record<string, number> }[] };

const gzipKb = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).length / 1024;

export function measure(dist: string): { entry: { file: string; kb: number }; firstLoad: { files: string[]; kb: number } } {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const entry = /<script type="module"[^>]*\bsrc="\/([^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error("bundle budget: no module entry in index.html");
  const statics = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((match) => match[1]!);
  const dictionaries = [...html.matchAll(/"(?:fr|en)":"\/(assets\/[^"]+\.js)"/g)].map((match) => match[1]!);
  if (dictionaries.length === 0) throw new Error("bundle budget: index.html preloads no dictionary (vite-locale-preload.ts)");
  const size = (file: string) => gzipKb(readFileSync(join(dist, file)));
  const largestDictionary = dictionaries.reduce((largest, file) => (size(file) > size(largest) ? file : largest));
  const files = [...new Set([...statics, largestDictionary])];
  return {
    entry: { file: entry, kb: size(entry) },
    firstLoad: { files, kb: files.reduce((sum, file) => sum + size(file), 0) },
  };
}

function largestModules(report: Report, files: string[], count: number): string[] {
  const rows: [string, number][] = [];
  for (const chunk of report.chunks) {
    if (!files.includes(chunk.fileName)) continue;
    for (const [module, bytes] of Object.entries(chunk.moduleBytes)) rows.push([module, bytes]);
  }
  return rows
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([module, bytes]) => `  ${(bytes / 1024).toFixed(0).padStart(5)} ko (rendered, pre-gzip)  ${module}`);
}

if (import.meta.main) {
  const [dist, reportPath] = process.argv.slice(2);
  if (!dist || !reportPath) {
    console.error("usage: bun apps/console/scripts/bundle-budget.ts <dist> <report.json>");
    process.exit(2);
  }
  const result = measure(dist);
  const over: string[] = [];
  if (result.entry.kb > BUDGET_KB.entry) over.push(`entry ${result.entry.kb.toFixed(1)} ko > ${BUDGET_KB.entry} ko`);
  if (result.firstLoad.kb > BUDGET_KB.firstLoad) over.push(`first load ${result.firstLoad.kb.toFixed(1)} ko > ${BUDGET_KB.firstLoad} ko`);
  console.log(
    `bundle-budget: entry ${result.entry.kb.toFixed(1)} / ${BUDGET_KB.entry} ko gzip (${result.entry.file}), `
    + `first load ${result.firstLoad.kb.toFixed(1)} / ${BUDGET_KB.firstLoad} ko gzip in ${result.firstLoad.files.length} files`,
  );
  if (over.length > 0) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    console.error(`bundle-budget failed: ${over.join("; ")}.`);
    console.error("Largest modules of the first load (load the screen that needs them lazily, see ADR 0001 D1b):");
    for (const line of largestModules(report, result.firstLoad.files, 15)) console.error(line);
    process.exit(1);
  }
}
