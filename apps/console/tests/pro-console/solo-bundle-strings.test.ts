import { describe, expect, test } from "bun:test";
import { decode, keysAlsoInCore, messageNeedles, ROUTE_NEEDLES, scan } from "../../scripts/solo-bundle-strings";

const core = [{ common: { cancel: "Annuler" }, billing: { plan: "Offre de démonstration du cœur" } }];
const pro = [{
  billing: { plan: "Offre de démonstration du cœur", checkoutTitle: "Toutes les offres disponibles pour l’organisation" },
  billingInvoices: { title: "Factures", empty: "Aucune facture disponible pour {name}" },
}];

describe("solo-bundle-strings", () => {
  const needles = [...ROUTE_NEEDLES, ...messageNeedles("i18n billing", pro, core)];

  test("pro namespaces and long strings become needles, core ones never do", () => {
    const texts = needles.filter((needle) => needle.category === "i18n billing").map((needle) => needle.text).sort();
    expect(texts).toEqual(["Aucune facture disponible pour", "Toutes les offres disponibles pour l’organisation", "billingInvoices"].sort());
  });

  test("a pro key put back into the core dictionaries is reported", () => {
    expect(keysAlsoInCore(pro, core)).toEqual(["billing.plan"]);
    expect(keysAlsoInCore([{ billingInvoices: { title: "x" } }], core)).toEqual([]);
  });

  test("a clean solo build has no hit", () => {
    const files = [
      { file: "assets/index.js", source: 'const a={billing:{plan:"Offre de démonstration du cœur"}};fetch("/api/organization/members")' },
    ];
    expect(scan(files, needles)).toEqual([]);
  });

  test("catches a pro route, namespace and escaped string", () => {
    const files = [
      { file: "assets/api.js", source: 'r(`/api/pro/billing/checkout`);q={billingInvoices:e=>e}' },
      { file: "assets/fr.js", source: 'x="Toutes les offres disponibles pour l\\u2019organisation"' },
    ];
    expect(scan(files, needles).map((hit) => `${hit.file} ${hit.kind}`)).toEqual([
      "assets/api.js route", "assets/api.js namespace", "assets/fr.js string",
    ]);
    expect(decode("l\\u2019organisation")).toBe("l’organisation");
  });
});
