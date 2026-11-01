import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { queryKeys } from "../../src/lib/api";
import { saveCloudSession } from "../../src/lib/session/cloud-session";
import { PRO_CONSOLE_ENTITLEMENTS, type ProConsoleModule } from "../../src/pro-console/contract";
import { proConsole, setProConsoleModulesForTest } from "../../src/pro-console/registry";
import { BotPermissionRules, hasFleetConsole, OrganizationPermissionRulesSettings } from "../../src/pro-console/slots";
import { useVisibleSettingsGroups } from "../../src/components/dashboard/settings-sidebar";

/**
 * The gates of the pro screens, in each pass of `make test-dual`. Solo: no
 * slot renders and no pro endpoint is called, whatever the session says.
 * Pro: a screen appears only when the session holds its entitlement.
 */
const pro = Boolean(process.env.OPENEDBOT_CONSOLE_PLUGINS?.trim());
const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  saveCloudSession({ organizationId: "org-1", userId: "u1", csrfToken: "fixture-csrf" });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return Response.json({ rules: [], enforced: true, max: 20 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setProConsoleModulesForTest(null);
});

function session(entitlements: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.authMe, { user: { id: "u1" }, entitlements });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
  );
}

const ALL = Object.values(PRO_CONSOLE_ENTITLEMENTS);
const bot = { id: "b1", name: "Bot" } as unknown as BotDto;
const proCalls = () => calls.filter((url) => url.includes("/api/pro/"));
const GROUPS = [{ title: "Compte", items: [{ url: "/settings/account" }, { url: "/settings/billing" }, { url: "/settings/clients" }, { url: "/settings/journal" }] }];
const visibleUrls = (entitlements: string[]) =>
  renderHook(() => useVisibleSettingsGroups(GROUPS), { wrapper: session(entitlements) }).result.current.flatMap((group) => group.items.map((item) => item.url));

if (!pro) {
  describe("solo console", () => {
    test("no permission-rules card and no /api/pro call, even with every entitlement", async () => {
      const Wrapper = session(ALL);
      const view = render(<Wrapper><OrganizationPermissionRulesSettings /><BotPermissionRules bot={bot} /></Wrapper>);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(view.container.innerHTML).toBe("");
      expect(proCalls()).toEqual([]);
    });

    test("no agency, billing or client settings entry", () => {
      expect(hasFleetConsole()).toBe(false);
      expect(visibleUrls(ALL)).toEqual(["/settings/account"]);
    });
  });
} else {
  describe("pro console", () => {
    test("the organization rules card loads with `permissions.rules`", async () => {
      const Wrapper = session([PRO_CONSOLE_ENTITLEMENTS.permissions]);
      render(<Wrapper><OrganizationPermissionRulesSettings /></Wrapper>);
      await waitFor(() => expect(proCalls()).toContain("/api/pro/permissions/organization/rules"), { timeout: 5000 });
    });

    test("the bot rules card loads with `permissions.rules`", async () => {
      const Wrapper = session([PRO_CONSOLE_ENTITLEMENTS.permissions]);
      render(<Wrapper><BotPermissionRules bot={bot} /></Wrapper>);
      await waitFor(() => expect(proCalls()).toContain("/api/pro/permissions/bots/b1/rules"), { timeout: 5000 });
    });

    test("without the entitlement: nothing, and no /api/pro call", async () => {
      const Wrapper = session([PRO_CONSOLE_ENTITLEMENTS.fleet]);
      const view = render(<Wrapper><OrganizationPermissionRulesSettings /><BotPermissionRules bot={bot} /></Wrapper>);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(view.container.innerHTML).toBe("");
      expect(proCalls()).toEqual([]);
    });

    test("billing settings entry only with `billing.enforced`; agency entries with the agency module", () => {
      expect(hasFleetConsole()).toBe(true);
      expect(visibleUrls(ALL)).toEqual(["/settings/account", "/settings/billing", "/settings/clients", "/settings/journal"]);
      expect(visibleUrls([PRO_CONSOLE_ENTITLEMENTS.fleet])).toEqual(["/settings/account", "/settings/clients", "/settings/journal"]);
    });
  });
}

describe("registry", () => {
  const Card = () => <p>rules card</p>;
  const permissions = (entitlement: string): ProConsoleModule => ({
    id: "fake",
    permissions: { entitlement, BotPermissionRules: Card, OrganizationPermissionRulesSettings: Card } as never,
  });

  test("a module renders behind its entitlement", async () => {
    setProConsoleModulesForTest([permissions(PRO_CONSOLE_ENTITLEMENTS.permissions)]);
    const With = session([PRO_CONSOLE_ENTITLEMENTS.permissions]);
    expect(render(<With><OrganizationPermissionRulesSettings /></With>).container.textContent).toBe("rules card");
    cleanup();
    const Without = session([]);
    expect(render(<Without><OrganizationPermissionRulesSettings /></Without>).container.textContent).toBe("");
  });

  test("rejects a module declaring another entitlement, or a feature provided twice", () => {
    expect(() => setProConsoleModulesForTest([permissions("permissions.other")])).toThrow(/must declare the entitlement "permissions.rules"/);
    const ok = permissions(PRO_CONSOLE_ENTITLEMENTS.permissions);
    expect(() => setProConsoleModulesForTest([ok, { ...ok, id: "again" }])).toThrow(/already provided/);
  });

  test("an empty list is a solo console", () => {
    setProConsoleModulesForTest([]);
    expect(proConsole()).toEqual({});
    expect(hasFleetConsole()).toBe(false);
  });
});
