import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../../src/lib/api";
import { readSupportDeskAvailable, supportDeskAvailable, useSupportDeskAvailable } from "../../../src/lib/support/support-desk-availability";

const source = (path: string) => readFileSync(new URL(`../../../src/${path}`, import.meta.url), "utf8");

let restore: Array<{ mockRestore: () => void }> = [];
afterEach(() => { cleanup(); for (const spy of restore) spy.mockRestore(); restore = []; });

function renderAvailability(health: () => Promise<Awaited<ReturnType<typeof api.health>>>) {
  const healthSpy = spyOn(api, "health").mockImplementation(health);
  const historySpy = spyOn(api.support, "history").mockImplementation(() => Promise.reject(new Error("no desk request expected")));
  restore.push(healthSpy, historySpy);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useSupportDeskAvailable(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...hook, healthSpy, historySpy };
}

describe("le guichet n'existe que si un plug-in le sert", () => {
  test("seul un `supportDesk: true` explicite ouvre le guichet", () => {
    expect(supportDeskAvailable({ supportDesk: true })).toBe(true);
    expect(supportDeskAvailable({ supportDesk: false })).toBe(false);
    // Une API sans le champ, une lecture en cours ou en échec : fermé.
    expect(supportDeskAvailable({})).toBe(false);
    expect(supportDeskAvailable(null)).toBe(false);
    expect(supportDeskAvailable(undefined)).toBe(false);
  });

  test("en solo (`supportDesk: false`), le hook dit non et aucune requête du guichet ne part", async () => {
    const h = renderAvailability(async () => ({ ok: true, version: "t", supportDesk: false }));
    await waitFor(() => expect(h.healthSpy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.result.current).toBe(false);
    expect(h.historySpy).not.toHaveBeenCalled();
  });

  test("en pro (`supportDesk: true`), le hook dit oui une fois la santé lue", async () => {
    const h = renderAvailability(async () => ({ ok: true, version: "t", supportDesk: true }));
    expect(h.result.current).toBe(false);
    await waitFor(() => expect(h.result.current).toBe(true));
  });

  test("une santé illisible ferme le guichet du garde de route", async () => {
    expect(await readSupportDeskAvailable(() => Promise.reject(new Error("down")))).toBe(false);
    expect(await readSupportDeskAvailable(async () => ({ supportDesk: true }))).toBe(true);
    expect(await readSupportDeskAvailable(async () => ({}))).toBe(false);
  });
});

describe("chaque porte du guichet suit la capacité", () => {
  test("la bulle se retire ET son guetteur ne demande rien sans guichet", () => {
    const launcher = source("components/support/support-launcher.tsx");
    expect(launcher).toContain("useSupportWatch(open || onSupportPage || !deskAvailable);");
    expect(launcher).toContain("if (!launcherVisible || !deskAvailable) return null;");
  });

  test("le bouton d'en-tête, le rail et le menu du compte se masquent", () => {
    expect(source("components/support/support-header-button.tsx")).toContain("if (here || !deskAvailable) return null;");
    const rails = source("components/boardui/board-rails.tsx");
    expect(rails.indexOf("{deskAvailable ? (")).toBeGreaterThan(-1);
    expect(rails.indexOf("{deskAvailable ? (")).toBeLessThan(rails.indexOf("<RailTip label={supportLabel}>"));
    const menu = source("components/boardui/account-menu.tsx");
    expect(menu.indexOf("{deskAvailable ? (")).toBeGreaterThan(-1);
    expect(menu.indexOf("{deskAvailable ? (")).toBeLessThan(menu.indexOf('label={t("boardui.support")}'));
  });

  test("`/support` renvoie à l'accueil avant que la page ne parle au guichet", () => {
    const routes = source("route-tree.tsx");
    const route = routes.slice(routes.indexOf("const supportRoute = createRoute({"), routes.indexOf("component: SupportScreen,"));
    expect(route).toContain("beforeLoad: async () => {");
    expect(route).toContain("readSupportDeskAvailable(");
    expect(route).toContain('throw redirect({ to: "/", replace: true });');
  });
});
