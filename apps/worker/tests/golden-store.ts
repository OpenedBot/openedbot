/**
 * The stored form of a golden differential (`*-golden.json`): each distinct
 * output once, each case as indices into it. Shared by the permission-port
 * goldens of the reviewer and the unattended gates.
 */
import { readFileSync, writeFileSync } from "node:fs";

type GoldenFile = { outputs: string[]; cases: Record<string, number[]> };

export function writeGoldenFile(path: string, computed: Record<string, string[]>, header: Record<string, unknown> = {}): void {
  const outputs: string[] = [];
  const index = new Map<string, number>();
  const cases: Record<string, number[]> = {};
  for (const [key, row] of Object.entries(computed)) {
    cases[key] = row.map((output) => {
      if (!index.has(output)) { index.set(output, outputs.length); outputs.push(output); }
      return index.get(output)!;
    });
  }
  const body = [
    "{",
    ...Object.entries(header).map(([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    ` "outputs": [\n${outputs.map((output) => `  ${JSON.stringify(output)}`).join(",\n")}\n ],`,
    ` "cases": {\n${Object.entries(cases).map(([key, row]) => `  ${JSON.stringify(key)}: ${JSON.stringify(row)}`).join(",\n")}\n }`,
    "}",
  ].join("\n");
  writeFileSync(path, `${body}\n`);
}

export function readGoldenFile(path: string): Record<string, string[]> {
  const file = JSON.parse(readFileSync(path, "utf8")) as GoldenFile;
  return Object.fromEntries(Object.entries(file.cases).map(([key, row]) => [key, row.map((at) => file.outputs[at]!)]));
}

/** Keys whose output differs, for a readable failure instead of a 3 000-line diff. */
export function differingCases(actual: Record<string, string[]>, golden: Record<string, string[]>): string[] {
  const keys = new Set([...Object.keys(actual), ...Object.keys(golden)]);
  return [...keys].filter((key) => JSON.stringify(actual[key]) !== JSON.stringify(golden[key])).sort();
}
