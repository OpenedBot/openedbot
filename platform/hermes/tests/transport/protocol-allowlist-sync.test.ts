import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as contracts from "@openedbot/contracts-connector";
import * as protocol from "../../../../protocol/connector/src/index";

/**
 * La référence publiée (`protocol/connector`) fait foi ; `contracts/connector`
 * la réexporte sans copie. Ce test échoue si une copie réapparaît (un fichier
 * de code dans `contracts/connector/src` autre qu'un réexport) ou si le
 * manifeste d'allowlist d'edge-setup diverge de celui de la référence.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("contracts/connector re-exports protocol/connector", () => {
  test("every export is the very same binding", () => {
    expect(Object.keys(contracts).sort()).toEqual(Object.keys(protocol).sort());
    for (const name of Object.keys(protocol)) {
      expect((contracts as Record<string, unknown>)[name]).toBe((protocol as Record<string, unknown>)[name]);
    }
  });

  test("contracts/connector/src holds re-exports only, no copy of the codec", () => {
    const dir = new URL("../../../../contracts/connector/src/", import.meta.url);
    for (const file of readdirSync(dir)) {
      const code = read(`../../../../contracts/connector/src/${file}`)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .trim();
      for (const statement of code.split("\n").filter((line) => line.trim() !== "")) {
        expect(statement).toMatch(/^export (\*|type \{[^}]+\}) from "@openedbot\/protocol-connector(\/[a-z0-9-]+)?";$/);
      }
    }
  });

  test("same allowlist manifest as the one the hermes client checks", () => {
    expect(read("../../../../protocol/connector/fixtures/relay-allowlist.json")).toBe(read("../fixtures/relay-allowlist.json"));
  });
});
