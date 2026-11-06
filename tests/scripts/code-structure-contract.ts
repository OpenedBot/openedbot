/**
 * Contrat de structure du code, hors réseau (`make test-unit`).
 *
 * 1. Taille des fichiers livrés. Un fichier `src/` de plus de MAX_LINES
 *    lignes ne passe pas, sauf s'il est inscrit dans
 *    `tests/scripts/code-size-debt.json` avec son plafond. Ce plafond est un
 *    cliquet : le fichier peut maigrir, jamais grossir. Une entrée devenue
 *    inutile (fichier disparu, ou repassé sous la limite) doit être retirée,
 *    sinon la dette ne se voit plus baisser. `--record` abaisse les
 *    plafonds aux tailles actuelles (constater un allègement) ; il n'inscrit
 *    jamais un nouveau fichier ni ne relève un plafond.
 *
 * 2. Domaines de `contracts/api`. Chaque dossier de `contracts/api/src/` est
 *    un domaine ; leurs imports forment un graphe sans cycle (un cycle de
 *    types seuls compris : deux domaines qui se citent l'un l'autre n'en
 *    font qu'un). `shared/` n'importe aucun autre domaine.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const MAX_LINES = 600;
const DEBT_FILE = join(root, "tests/scripts/code-size-debt.json");
const LAYERS = ["apps", "modules", "platform", "contracts", "protocol", "browser"];
const SKIPPED = /(\.test\.tsx?|\.d\.ts|\.bench\.tsx?)$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !SKIPPED.test(entry)) out.push(path);
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const layer of LAYERS) {
    for (const pkg of readdirSync(join(root, layer))) {
      const src = join(root, layer, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, files);
      } catch {
        // A package without src/ ships no code here.
      }
    }
  }
  return files.map((file) => relative(root, file)).sort();
}

function lineCount(path: string): number {
  const text = readFileSync(join(root, path), "utf8");
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const errors: string[] = [];

// 1. File size ratchet.
const sizes = new Map(sourceFiles().map((file) => [file, lineCount(file)]));
const debt = JSON.parse(readFileSync(DEBT_FILE, "utf8")) as Record<string, number>;
const recording = process.argv.includes("--record");
const bootstrapping = process.argv.includes("--bootstrap");
if (recording || bootstrapping) {
  // --record only lowers existing ceilings; --bootstrap (once, when the
  // contract was introduced) also inscribes the files already too long.
  const recorded: Record<string, number> = {};
  for (const [file, lines] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    if (lines <= MAX_LINES) continue;
    const ceiling = debt[file];
    if (ceiling !== undefined) recorded[file] = Math.min(lines, ceiling);
    else if (bootstrapping) recorded[file] = lines;
  }
  await Bun.write(DEBT_FILE, `${JSON.stringify(recorded, null, 2)}\n`);
  console.log(`code-structure-contract: ${Object.keys(recorded).length} fichiers inscrits dans ${relative(root, DEBT_FILE)}.`);
}
const ceilings = JSON.parse(readFileSync(DEBT_FILE, "utf8")) as Record<string, number>;
for (const [file, lines] of sizes) {
  const ceiling = ceilings[file];
  if (ceiling === undefined && lines > MAX_LINES) {
    errors.push(`${file} : ${lines} lignes, au-delà de ${MAX_LINES}. Découpez-le par responsabilité.`);
  } else if (ceiling !== undefined && lines > ceiling) {
    errors.push(`${file} : ${lines} lignes, au-delà de son plafond de dette (${ceiling}). Il ne doit plus grossir : découpez avant d'ajouter.`);
  }
}
for (const [file, ceiling] of Object.entries(ceilings)) {
  const lines = sizes.get(file);
  if (lines === undefined) errors.push(`${file} : inscrit dans la dette mais absent. Retirez l'entrée.`);
  else if (lines <= MAX_LINES) errors.push(`${file} : ${lines} lignes, repassé sous ${MAX_LINES}. Retirez l'entrée de la dette.`);
  else if (lines < ceiling) errors.push(`${file} : ${lines} lignes pour un plafond de ${ceiling}. Abaissez le plafond (--record) pour garder le gain.`);
}

// 2. contracts/api domain graph.
const apiSrc = join(root, "contracts/api/src");
const domains = readdirSync(apiSrc).filter((entry) => statSync(join(apiSrc, entry)).isDirectory()).sort();
const edges = new Map(domains.map((domain) => [domain, new Set<string>()]));
for (const domain of domains) {
  const files: string[] = [];
  walk(join(apiSrc, domain), files);
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+"\.\.\/([a-z0-9-]+)\//g)) {
      if (match[1] !== domain) edges.get(domain)!.add(match[1]!);
    }
  }
}
if (edges.get("shared")?.size) errors.push(`contracts/api/src/shared importe ${[...edges.get("shared")!].join(", ")} : shared/ ne dépend d'aucun domaine.`);
const state = new Map<string, "visiting" | "done">();
const visit = (domain: string, path: string[]): void => {
  if (state.get(domain) === "done") return;
  if (state.get(domain) === "visiting") {
    errors.push(`contracts/api : cycle entre domaines ${[...path.slice(path.indexOf(domain)), domain].join(" -> ")}.`);
    return;
  }
  state.set(domain, "visiting");
  for (const next of edges.get(domain) ?? []) visit(next, [...path, domain]);
  state.set(domain, "done");
};
for (const domain of domains) visit(domain, []);

if (errors.length > 0) {
  for (const error of errors) console.error(`code-structure-contract: ${error}`);
  process.exit(1);
}
console.log(`code-structure-contract: ${sizes.size} fichiers, ${Object.keys(ceilings).length} en dette de taille (plafonds tenus) ; ${domains.length} domaines dans contracts/api, sans cycle.`);
