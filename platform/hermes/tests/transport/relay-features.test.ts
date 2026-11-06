import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as connector from "@openedbot/contracts-connector";
import { RELAY_HOST_FEATURES, RELAY_LINK_FEATURES } from "@openedbot/contracts-connector";
import { edgeSetupPath } from "../../../../tests/edge-setup-dir";

/**
 * Parité des noms de fonctionnalités entre l'hôte (Go, `HostFeatures` et
 * `LinkFeatures` de `edge-setup/internal/connector/frames.go`) et openedbot
 * (TS, `protocol/connector/src/relay-features.ts`). Un nom ajouté, retiré,
 * renommé ou déplacé d'un seul côté fait échouer ce test : l'hôte annoncerait
 * une fonctionnalité qu'openedbot ne sait pas nommer, ou l'inverse.
 */
const goSource = readFileSync(edgeSetupPath("internal/connector/frames.go"), "utf8");

/** Toutes les constantes `FeatureXxx = "nom"` du fichier Go, blocs `const (...)` compris. */
function goFeatureConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const match of source.matchAll(/^\s*(?:const\s+)?(Feature[A-Za-z0-9]+)\s*=\s*"([^"]*)"/gm)) {
    constants.set(match[1]!, match[2]!);
  }
  return constants;
}

/** Les éléments d'un `var Nom = []string{...}`, résolus en chaînes, dans l'ordre. */
function goFeatureList(source: string, name: string, constants: Map<string, string>): string[] {
  const body = new RegExp(`var ${name} = \\[\\]string\\{([^}]*)\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`frames.go: var ${name} = []string{...} not found`);
  return body.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const literal = /^"([^"]*)"$/.exec(item);
    if (literal) return literal[1]!;
    const value = constants.get(item);
    if (value === undefined) throw new Error(`frames.go: ${name} lists ${item}, which is not a Feature constant of this file`);
    return value;
  });
}

const constants = goFeatureConstants(goSource);

describe("feature names: one list in Go, one list in TypeScript", () => {
  test("HostFeatures (Go) and RELAY_HOST_FEATURES (TS) are the same names in the same order", () => {
    expect<string[]>([...RELAY_HOST_FEATURES]).toEqual(goFeatureList(goSource, "HostFeatures", constants));
  });

  test("LinkFeatures (Go) and RELAY_LINK_FEATURES (TS) are the same names in the same order", () => {
    expect<string[]>([...RELAY_LINK_FEATURES]).toEqual(goFeatureList(goSource, "LinkFeatures", constants));
  });

  test("every Go Feature constant is in one of the two lists", () => {
    const listed = new Set([...RELAY_HOST_FEATURES, ...RELAY_LINK_FEATURES]);
    expect(constants.size).toBeGreaterThan(0);
    expect([...constants.values()].filter((name) => !listed.has(name as never)).sort()).toEqual([]);
  });

  test("every exported RELAY_FEATURE_* constant is in exactly one list, and nothing else is", () => {
    const exported = Object.entries(connector)
      .filter(([key]) => key.startsWith("RELAY_FEATURE_"))
      .map(([, value]) => value as string)
      .sort();
    expect(exported).toEqual([...RELAY_HOST_FEATURES, ...RELAY_LINK_FEATURES].sort());
    expect(new Set(exported).size).toBe(exported.length);
  });

  test("names stay within the wire bound of a feature name", () => {
    for (const name of [...RELAY_HOST_FEATURES, ...RELAY_LINK_FEATURES]) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(RELAY_HOST_FEATURES.length + RELAY_LINK_FEATURES.length).toBeLessThanOrEqual(connector.RELAY_MAX_FEATURES);
  });
});

/**
 * Garde : aucun code livré n'écrit un nom de fonctionnalité en dur, hors de
 * `protocol/connector`. Les commentaires (entre backticks) ne comptent pas ;
 * une chaîne entre guillemets, simples (SQL) ou doubles, oui.
 */
describe("feature names are spelled in protocol/connector only", () => {
  const root = new URL("../../../../", import.meta.url).pathname;
  // `a2a_audit` est aussi la `source` des enregistrements du journal A2A : une autre chose, même mot.
  const SAME_WORD_ELSEWHERE: Record<string, readonly string[]> = {
    a2a_audit: ["contracts/api/src/a2a/audit.ts", "platform/hermes/src/a2a-audit.ts", "modules/runtimes/src/application/a2a-audit.ts"],
  };

  test("no quoted feature name in apps, modules, platform, contracts or browser sources", () => {
    const names = [...RELAY_HOST_FEATURES, ...RELAY_LINK_FEATURES];
    const pattern = new RegExp(`(["'])(${names.join("|")})\\1`, "g");
    const offenders: string[] = [];
    for (const layer of ["apps", "modules", "platform", "contracts", "browser"]) {
      for (const file of new Bun.Glob(`${layer}/*/src/**/*.{ts,tsx}`).scanSync(root)) {
        if (file.includes("/node_modules/") || /\.test\.tsx?$/.test(file)) continue;
        const text = readFileSync(`${root}${file}`, "utf8");
        for (const match of text.matchAll(pattern)) {
          if (SAME_WORD_ELSEWHERE[match[2]!]?.includes(file)) continue;
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
