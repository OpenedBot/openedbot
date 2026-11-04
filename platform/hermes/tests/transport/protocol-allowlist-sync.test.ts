import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RELAY_ALLOWLIST, type RelayRoute } from "@openedbot/contracts-connector";
import { RELAY_ALLOWLIST as PROTOCOL_ALLOWLIST } from "../../../../protocol/connector/src/relay-allowlist";

/**
 * La référence publiée (`protocol/connector`) est une copie de
 * `contracts/connector` et du manifeste d'edge-setup, rafraîchie par
 * `protocol/scripts/sync-from-siblings.sh`. Une route ajoutée d'un côté
 * seulement fait refuser par un connecteur tiers ce que le SDK courant
 * demande : ce test échoue tant que les copies divergent.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function routeKey(route: RelayRoute): string {
  return [
    route.method,
    route.path.source,
    `events=${route.events}`,
    `host=${route.host}`,
    `rootOnly=${route.rootOnly === true}`,
    `noQuery=${route.noQuery === true}`,
    `query=${route.query?.source ?? ""}`,
  ].join(" ");
}

describe("protocol reference allowlist stays in sync with contracts/connector", () => {
  test("same routes, same flags", () => {
    expect(PROTOCOL_ALLOWLIST.map(routeKey).sort()).toEqual(RELAY_ALLOWLIST.map(routeKey).sort());
  });

  test("same source file, byte for byte", () => {
    expect(read("../../../../protocol/connector/src/relay-allowlist.ts")).toBe(read("../../../../contracts/connector/src/relay-allowlist.ts"));
  });

  test("same allowlist manifest as the one the hermes client checks", () => {
    expect(read("../../../../protocol/connector/fixtures/relay-allowlist.json")).toBe(read("../fixtures/relay-allowlist.json"));
  });
});
