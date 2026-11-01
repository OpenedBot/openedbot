import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDto, BillingUsageDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { proConsole } from "../../src/pro-console/registry";

/**
 * `/settings/billing` disait quatre plafonds nus : rien n'y montrait ce qui
 * était déjà occupé, donc rien n'y disait s'il restait de la marge. La carte
 * de limites porte maintenant les deux, et ces tests tiennent la lecture :
 * l'occupation vient de l'API, jamais d'une estimation du client.
 *
 * Étape 8d : l'écran vit dans un plug-in externe (`pro-billing/console`) et lit
 * `/api/pro/billing/subscription` ; il ne se rend qu'avec le module de la
 * passe pro de `make test-dual`. En solo, aucun écran de facturation.
 */
const BillingSettings = proConsole().billing?.BillingSettings;
const pro = Boolean(process.env.OHB_PRO_CONSOLE?.trim());

const realFetch = globalThis.fetch;

const PLAN: BillingDto["plan"] = {
  amountEur: 39,
  currency: "EUR",
  interval: "month",
  runtimeLimit: 1,
  memberLimit: 2,
  concurrentRunLimit: 4,
  attachmentQuotaBytes: 1_073_741_824,
};

function stubBilling(usage: BillingUsageDto, subscription: BillingDto["subscription"] = null) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/pro/billing/subscription")) {
      return Response.json({ subscription, plan: PLAN, usage, configured: false, enforced: false });
    }
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: "u-1", email: "elodie@example.test", displayName: "Élodie" },
        organization: { id: "org-1", slug: "acme", name: "Acme" },
        role: "owner",
      });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
}

function renderBilling() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><Suspense fallback={null}>{BillingSettings ? <BillingSettings /> : null}</Suspense></I18nProvider>
    </QueryClientProvider>,
  );
}

const proTest = pro ? test : test.skip;

describe("billing module (step 8d)", () => {
  test(pro ? "pro: the billing screen comes from the pro module" : "solo: no billing screen in the console", () => {
    expect(Boolean(BillingSettings)).toBe(pro);
  });
});

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  window.localStorage.setItem("ohb:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

proTest("chaque plafond du plan se lit avec ce qui l’occupe", async () => {
  stubBilling({ runtimes: 1, members: 2, concurrentRuns: 1, attachmentBytes: 536_870_912 });
  renderBilling();
  expect(await screen.findByText("Edge : 1 sur 1")).toBeTruthy();
  expect(screen.getByText("Membres : 2 sur 2")).toBeTruthy();
  expect(screen.getByText("Runs simultanés : 1 sur 4")).toBeTruthy();
});

proTest("la part occupée d’un plafond se voit en jauge", async () => {
  stubBilling({ runtimes: 0, members: 1, concurrentRuns: 2, attachmentBytes: 0 });
  renderBilling();
  const runtimes = await screen.findByRole("progressbar", { name: "Edge : 0 sur 1" });
  expect(runtimes.getAttribute("aria-valuenow")).toBe("0");
  expect(screen.getByRole("progressbar", { name: "Membres : 1 sur 2" }).getAttribute("aria-valuenow")).toBe("50");
  expect(screen.getByRole("progressbar", { name: "Runs simultanés : 2 sur 4" }).getAttribute("aria-valuenow")).toBe("50");
});

// Une occupation qui dépasse son plafond arrive : le plan a rétréci, ou la
// ligne d'abonnement a été remise à zéro avant que les runtimes soient
// révoqués. La jauge sature au lieu de déborder de sa piste.
proTest("une occupation au-delà du plafond sature la jauge", async () => {
  stubBilling({ runtimes: 3, members: 0, concurrentRuns: 0, attachmentBytes: 0 });
  renderBilling();
  const runtimes = await screen.findByRole("progressbar", { name: "Edge : 3 sur 1" });
  expect(runtimes.getAttribute("aria-valuenow")).toBe("100");
});

// Sans abonnement actif, ce sont les plafonds du plan affiché qui font foi.
// Avec un abonnement actif, ce sont les siens, qui peuvent différer.
proTest("l’abonnement actif impose ses plafonds à la place du plan", async () => {
  stubBilling(
    { runtimes: 1, members: 3, concurrentRuns: 0, attachmentBytes: 0 },
    {
      status: "active",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      runtimeLimit: 4,
      memberLimit: 10,
      concurrentRunLimit: 8,
      attachmentQuotaBytes: 2_147_483_648,
      updatedAt: null,
    },
  );
  renderBilling();
  expect(await screen.findByText("Edge : 1 sur 4")).toBeTruthy();
  expect(screen.getByText("Membres : 3 sur 10")).toBeTruthy();
});

proTest("le stockage occupé se lit en octets lisibles, pas en nombre brut", async () => {
  stubBilling({ runtimes: 0, members: 0, concurrentRuns: 0, attachmentBytes: 536_870_912 });
  renderBilling();
  const toggle = await screen.findByRole("button", { name: "Détailler le stockage" });
  expect(toggle.textContent).toContain("512 Mio sur 1 Gio");
  // La moitié du quota, dite en toutes lettres : c'est le seul chiffre que la
  // barre ne peut pas montrer seule.
  expect(toggle.textContent).toContain("50.0%");
});
