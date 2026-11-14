import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingDto, BillingUsageDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { proConsole } from "../../src/pro-console/registry";

/**
 * `/settings/billing` showed four bare ceilings: nothing there showed what was
 * already occupied, so nothing there said whether any headroom remained. The limits
 * card now carries both, and these tests hold that reading:
 * occupancy comes from the API, never from a client estimate.
 *
 * Step 8d: the screen lives in an external plug-in (`pro-billing/console`) and reads
 * `/api/pro/billing/subscription`; it renders only with the module of the
 * pro pass of `make test-dual`. Solo, no billing screen.
 */
const BillingSettings = proConsole().billing?.BillingSettings;
const pro = Boolean(process.env.OPENEDBOT_CONSOLE_PLUGINS?.trim());

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
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
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

// An occupancy that exceeds its ceiling does happen: the plan shrank, or the
// subscription row was reset to zero before the runtimes were
// revoked. The gauge saturates instead of overflowing its track.
proTest("une occupation au-delà du plafond sature la jauge", async () => {
  stubBilling({ runtimes: 3, members: 0, concurrentRuns: 0, attachmentBytes: 0 });
  renderBilling();
  const runtimes = await screen.findByRole("progressbar", { name: "Edge : 3 sur 1" });
  expect(runtimes.getAttribute("aria-valuenow")).toBe("100");
});

// Without an active subscription, the displayed plan's ceilings are authoritative.
// With an active subscription, its own are, and they can differ.
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
  // Half the quota, spelled out: it is the only figure the
  // bar cannot show on its own.
  expect(toggle.textContent).toContain("50.0%");
});
