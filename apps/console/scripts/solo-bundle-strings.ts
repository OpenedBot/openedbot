/**
 * `make solo-check`, second half: greps the OUTPUT of a console build for
 * what only the pro screens use, whatever module brought it in.
 *
 *   bun apps/console/scripts/solo-bundle-strings.ts solo <dist> <messages.ts>...
 *     fails on ANY hit: a pro route (`/api/pro/`, where every plug-in
 *     route lives since step 11.2), or a pro message namespace or string;
 *   bun apps/console/scripts/solo-bundle-strings.ts pro <dist> <messages.ts>...
 *     the positive control: fails unless every category has hits, so a
 *     needle that no longer matches anything cannot pass silently.
 *
 * The pro strings are not listed here: they are read from the message files
 * given on the command line (the plug-in repo's
 * `packages/<pkg>/console/messages.*.ts`), minus anything the
 * core dictionaries also carry. Namespaces are matched as `name:`, `"name"`
 * or `` `name. ``; strings by their longest literal run of 20+ characters.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

type Tree = { readonly [key: string]: string | Tree };
export type Needle = { category: string; text: string; kind: "route" | "namespace" | "string" };
export type Hit = Needle & { file: string };

export const ROUTE_NEEDLES: Needle[] = [
  { category: "route /api/pro/", text: "/api/pro/", kind: "route" },
];

function paths(tree: Tree, prefix = "", out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    typeof value === "string" ? out.push(path) : paths(value, path, out);
  }
  return out;
}

/**
 * A pro key that is also a core key: the core text wins at run time and,
 * worse, sits in every solo bundle. Moving pro strings back into the core
 * dictionaries is caught here, not by the needles (they skip core text).
 */
export function keysAlsoInCore(trees: Tree[], core: Tree[]): string[] {
  const corePaths = new Set(core.flatMap((tree) => paths(tree)));
  return [...new Set(trees.flatMap((tree) => paths(tree)).filter((path) => corePaths.has(path)))].sort();
}

function leaves(tree: Tree, out: string[] = []): string[] {
  for (const value of Object.values(tree)) typeof value === "string" ? out.push(value) : leaves(value, out);
  return out;
}

/** Longest run without a `{param}`, so an interpolated string still matches. */
function literalRun(value: string): string {
  return value.split(/\{[^}]*\}/).reduce((best, part) => (part.trim().length > best.length ? part.trim() : best), "");
}

export function messageNeedles(category: string, trees: Tree[], core: Tree[]): Needle[] {
  const coreTop = new Set(core.flatMap((tree) => Object.keys(tree)));
  const coreValues = new Set(core.flatMap((tree) => leaves(tree)));
  const needles = new Map<string, Needle>();
  for (const tree of trees) {
    for (const name of Object.keys(tree)) {
      if (!coreTop.has(name)) needles.set(`ns:${name}`, { category, text: name, kind: "namespace" });
    }
    for (const value of leaves(tree)) {
      const run = literalRun(value);
      if (run.length >= 20 && !coreValues.has(value) && ![...coreValues].some((core) => core.includes(run))) {
        needles.set(`s:${run}`, { category, text: run, kind: "string" });
      }
    }
  }
  return [...needles.values()];
}

/** Minifiers may escape non-ASCII text: compare decoded. */
export function decode(source: string): string {
  return source
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matches(needle: Needle, source: string): boolean {
  if (needle.kind !== "namespace") return source.includes(needle.text);
  const name = escapeRegExp(needle.text);
  return new RegExp(`(^|[^\\w$.])${name}\\s*:|["'\`]${name}["'\`.]`).test(source);
}

export function scan(files: { file: string; source: string }[], needles: Needle[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, source } of files) {
    const text = decode(source);
    for (const needle of needles) {
      if (matches(needle, text)) hits.push({ ...needle, file });
    }
  }
  return hits;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function treesOf(paths: string[]): Promise<Tree[]> {
  const trees: Tree[] = [];
  for (const path of paths) {
    const module = (await import(resolve(path))) as Record<string, unknown>;
    trees.push(...(Object.values(module) as Tree[]));
  }
  return trees;
}

/** `billing.fr.ts` → `billing`, `packages/pro-billing/console/messages.fr.ts` → `pro-billing`. */
function categoryOf(path: string): string {
  const name = basename(path);
  if (name.startsWith("messages.")) return `i18n ${basename(resolve(path, "../.."))}`;
  return `i18n ${name.split(".")[0]}`;
}

if (import.meta.main) {
  const [mode, dist, ...messageFiles] = process.argv.slice(2);
  // Solo may run without the plug-in checkout (public repository): then only
  // the route needles apply. The positive control needs the pro strings.
  if ((mode !== "solo" && mode !== "pro") || !dist || (mode === "pro" && messageFiles.length === 0)) {
    console.error("usage: solo-bundle-strings.ts solo <dist> [<messages.ts>...] | pro <dist> <messages.ts>...");
    process.exit(2);
  }
  const coreDir = resolve(import.meta.dir, "../../../contracts/i18n/src");
  const core = await treesOf([join(coreDir, "messages.fr.ts"), join(coreDir, "messages.en.ts")]);
  const byCategory = new Map<string, string[]>();
  for (const path of messageFiles) byCategory.set(categoryOf(path), [...(byCategory.get(categoryOf(path)) ?? []), path]);
  const needles = [...ROUTE_NEEDLES];
  const duplicated: string[] = [];
  for (const [category, files] of byCategory) {
    const trees = await treesOf(files);
    duplicated.push(...keysAlsoInCore(trees, core).map((path) => `${category} ${path}`));
    needles.push(...messageNeedles(category, trees, core));
  }
  if (duplicated.length > 0) {
    for (const key of duplicated.slice(0, 20)) console.error(`[solo-check] clé pro aussi dans les dictionnaires du cœur : ${key}`);
    console.error(`[solo-check] ${mode} : ${duplicated.length} clé(s) pro dans le cœur`);
    process.exit(1);
  }
  const files = walk(dist).filter((path) => path.endsWith(".js")).map((path) => ({ file: relative(dist, path), source: readFileSync(path, "utf8") }));
  const hits = scan(files, needles);
  const categories = [...new Set(needles.map((needle) => needle.category))];
  const count = (category: string) => hits.filter((hit) => hit.category === category).length;
  console.log(`[solo-check] ${mode} : ${files.length} fichiers JS, ${needles.length} motifs (${categories.map((c) => `${c} ${needles.filter((n) => n.category === c).length}`).join(", ")})`);
  if (mode === "solo") {
    if (hits.length > 0) {
      for (const hit of hits.slice(0, 40)) console.error(`[solo-check] chaîne pro dans le bundle solo : ${hit.category} ${hit.kind} « ${hit.text.slice(0, 60)} » dans ${hit.file}`);
      console.error(`[solo-check] solo : ${hits.length} occurrence(s) pro`);
      process.exit(1);
    }
    console.log("[solo-check] solo : aucune route ni chaîne pro dans le build");
  } else {
    const missing = categories.filter((category) => count(category) === 0);
    if (missing.length > 0) {
      console.error(`[solo-check] pro : aucune occurrence pour ${missing.join(", ")} (motif périmé ?)`);
      process.exit(1);
    }
    console.log(`[solo-check] pro : ${categories.map((c) => `${c} ${count(c)}`).join(", ")}`);
  }
}
