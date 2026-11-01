/**
 * Compiles exactly the Tailwind utilities a rendered page uses, so the report
 * is one self-contained file: no CDN, readable offline, in an archive or as
 * a CI artifact. Candidates come from the page's own `class` attributes.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";

export function classCandidates(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\bclass="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) found.add(token);
  }
  return [...found];
}

export async function tailwindCss(html: string): Promise<string> {
  const root = dirname(Bun.resolveSync("tailwindcss/package.json", import.meta.dir));
  const compiler = await compile(`@import "tailwindcss";`, {
    base: root,
    loadStylesheet: async (id, base) => {
      const path = id === "tailwindcss" ? resolve(root, "index.css") : resolve(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classCandidates(html));
}
