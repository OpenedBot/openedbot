/**
 * `make solo-check`: reads the module report of a console build
 * (`vite-module-report.ts`) and proves which pro screens it carries.
 *
 *   bun apps/console/scripts/solo-bundle-check.ts solo <report.json>
 *     fails if ANY pro screen module, pro package file or pro-named chunk is
 *     in the bundle (billing, permission rules);
 *   bun apps/console/scripts/solo-bundle-check.ts pro <report.json>
 *     the positive control: fails unless each of them is there.
 *
 * Prints the sizes either way. `solo-bundle-strings.ts` then greps the
 * build output itself for pro routes, strings and selectors.
 */
import { readFileSync } from "node:fs";

type Report = {
  chunks: { fileName: string; name: string; bytes: number; modules: string[] }[];
  assets: { fileName: string; bytes: number }[];
};

/** The pro screens, as module ids relative to the core root. */
export const PRO_SCREEN_MODULES: { feature: "billing" | "permissions"; test: (id: string) => boolean }[] = [
  { feature: "billing", test: (id) => /(^|\/)packages\/pro-billing\/console\//.test(id) },
  { feature: "permissions", test: (id) => /(^|\/)packages\/pro-permissions\/console\//.test(id) || id === "apps/console/src/components/settings/permission-rules.tsx" },
];

/** The chunk names those screens produce (`<name>-<hash>.js`). */
const PRO_CHUNK_NAMES = /^(billing|permission-rules)$/;

export function proModulesIn(report: Report): { feature: string; chunk: string; module: string }[] {
  const found: { feature: string; chunk: string; module: string }[] = [];
  for (const chunk of report.chunks) {
    for (const module of chunk.modules) {
      const hit = PRO_SCREEN_MODULES.find((rule) => rule.test(module)) ?? (/(^|\/)packages\/pro-[a-z-]+\//.test(module) ? { feature: "pro" } : undefined);
      if (hit) found.push({ feature: hit.feature, chunk: chunk.fileName, module });
    }
  }
  return found;
}

export function proChunksIn(report: Report): string[] {
  return report.chunks.filter((chunk) => PRO_CHUNK_NAMES.test(chunk.name)).map((chunk) => chunk.fileName);
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function sizes(report: Report): string {
  const js = report.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  const css = report.assets.filter((asset) => asset.fileName.endsWith(".css")).reduce((sum, asset) => sum + asset.bytes, 0);
  const entry = report.chunks.filter((chunk) => /^assets\/index-/.test(chunk.fileName)).reduce((sum, chunk) => sum + chunk.bytes, 0);
  return `${report.chunks.length} chunks JS, ${kb(js)} de JS (entrée ${kb(entry)}), ${kb(css)} de CSS`;
}

if (import.meta.main) {
  const [mode, path] = process.argv.slice(2);
  if ((mode !== "solo" && mode !== "pro") || !path) {
    console.error("usage: solo-bundle-check.ts solo|pro <report.json>");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as Report;
  const modules = proModulesIn(report);
  const chunks = proChunksIn(report);
  console.log(`[solo-check] ${mode} : ${sizes(report)}`);
  if (mode === "solo") {
    if (modules.length > 0 || chunks.length > 0) {
      for (const hit of modules) console.error(`[solo-check] écran pro dans le bundle solo : ${hit.module} (${hit.feature}, ${hit.chunk})`);
      for (const chunk of chunks) console.error(`[solo-check] chunk pro dans le bundle solo : ${chunk}`);
      process.exit(1);
    }
    console.log("[solo-check] solo : aucun écran ni chunk pro (facturation, règles de permission)");
  } else {
    const missing = (["billing", "permissions"] as const).filter((feature) => !modules.some((hit) => hit.feature === feature));
    if (missing.length > 0) {
      console.error(`[solo-check] pro : absents du bundle pro : ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`[solo-check] pro : ${modules.length} modules pro, chunks ${chunks.map((chunk) => chunk.replace(/^assets\//, "")).join(" ")}`);
  }
}
