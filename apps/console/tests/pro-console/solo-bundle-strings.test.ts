import { describe, expect, test } from "bun:test";
import { CSS_NEEDLES, decode, keysAlsoInCore, messageNeedles, ROUTE_NEEDLES, scan } from "../../scripts/solo-bundle-strings";

const core = [{ common: { cancel: "Annuler" }, fleet: { personal: "Espace personnel de démonstration" } }];
const pro = [{
  fleet: { personal: "Espace personnel de démonstration", fleetTitle: "Toutes les organisations clientes de l’agence" },
  agencyJournal: { title: "Journal", empty: "Aucun événement pour {name} dans cette agence" },
}];

describe("solo-bundle-strings", () => {
  const needles = [...ROUTE_NEEDLES, ...CSS_NEEDLES, ...messageNeedles("i18n agency", pro, core)];

  test("pro namespaces and long strings become needles, core ones never do", () => {
    const texts = needles.filter((needle) => needle.category === "i18n agency").map((needle) => needle.text).sort();
    expect(texts).toEqual(["Aucun événement pour", "Toutes les organisations clientes de l’agence", "agencyJournal"].sort());
  });

  test("a pro key put back into the core dictionaries is reported", () => {
    expect(keysAlsoInCore(pro, core)).toEqual(["fleet.personal"]);
    expect(keysAlsoInCore([{ agencyJournal: { title: "x" } }], core)).toEqual([]);
  });

  test("a clean solo build has no hit", () => {
    const files = [
      { file: "assets/index.js", source: 'const a={fleet:{personal:"Espace personnel de démonstration"}};fetch("/api/organization/fleet-grants")' },
      { file: "assets/index.css", source: "[data-board-header-root]{color:red}" },
    ];
    expect(scan(files, needles)).toEqual([]);
  });

  test("catches a pro route, namespace, escaped string and agency selector", () => {
    const files = [
      { file: "assets/api.js", source: 'r(`/api/pro/billing/checkout`);q={agencyJournal:e=>e}' },
      { file: "assets/fr.js", source: 'x="Toutes les organisations clientes de l\\u2019agence"' },
      { file: "assets/index.css", source: "[data-agency-rail]{padding:0}" },
    ];
    expect(scan(files, needles).map((hit) => `${hit.file} ${hit.kind}`)).toEqual([
      "assets/api.js route", "assets/api.js namespace", "assets/fr.js string", "assets/index.css css",
    ]);
    expect(decode("l\\u2019agence")).toBe("l’agence");
  });
});
