/**
 * `virtual:ohb-pro-console`: the pro console modules of this build
 * (open-core step 9, `src/pro-console/contract.ts`).
 *
 * `OPENEDBOT_CONSOLE_PLUGINS` lists them, comma-separated, like `OPENEDBOT_PLUGINS` for
 * the API: absolute paths (a plug-in package's `console/index.ts`) or
 * resolvable specifiers. Empty or unset is solo: the module is
 * an empty list and no pro screen, chunk or style enters the bundle.
 *
 * Pure functions and a Vite plugin; `test-setup.ts` feeds the same source to
 * bun test, so the tests see what the bundle sees.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const PRO_CONSOLE_VIRTUAL_ID = "virtual:ohb-pro-console";
const RESOLVED_ID = `\0${PRO_CONSOLE_VIRTUAL_ID}`;

/** `@openedbot/console/<name>`: what the core lends a pro module (`host`, `contract`, the seams). */
export const CONSOLE_HOST_PREFIX = "@openedbot/console";
export const CONSOLE_HOST_DIR = fileURLToPath(new URL("./src/pro-console", import.meta.url));

export function proConsoleEntries(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** The virtual module: a function, so a cycle through a frame never reads it half-evaluated. */
export function proConsoleModuleSource(entries: readonly string[]): string {
  const imports = entries.map((entry, index) => `import m${index} from ${JSON.stringify(entry)};`);
  const list = entries.map((_, index) => `m${index}`).join(", ");
  return [...imports, `const modules = [${list}];`, "export default () => modules;", ""].join("\n");
}

/** Tailwind scans `apps/console` only (`@source ".."`): a pro module's own directory is added. */
export function proConsoleStyleSources(entries: readonly string[]): string[] {
  return entries.filter((entry) => isAbsolute(entry)).map((entry) => `@source ${JSON.stringify(dirname(entry))};`);
}

export function proConsole(entries: readonly string[]): Plugin {
  const absolute = entries.filter((entry) => isAbsolute(entry));
  return {
    name: "ohb-pro-console",
    enforce: "pre",
    config: () => ({
      resolve: {
        // One React, one router, one query client for the core and the pro modules.
        dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "@tabler/icons-react", "lucide-react"],
      },
      server: absolute.length > 0 ? { fs: { allow: [resolve(CONSOLE_HOST_DIR, "../../../.."), ...absolute.map((entry) => dirname(entry))] } } : undefined,
    }),
    resolveId(id) {
      return id === PRO_CONSOLE_VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      return id === RESOLVED_ID ? proConsoleModuleSource(entries) : null;
    },
    transform(code, id) {
      if (absolute.length === 0 || !id.split("?")[0]!.endsWith("/src/styles/globals.css")) return null;
      return { code: `${code}\n${proConsoleStyleSources(absolute).join("\n")}\n`, map: null };
    },
  };
}
