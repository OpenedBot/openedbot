import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RuntimeHermesUpdateDto, RuntimeLinkDto } from "@openedbot/contracts-api";
import { queryKeys } from "../../../src/lib/api";
import { I18nProvider } from "../../../src/lib/i18n";
import { hermesUpdate } from "../../../src/lib/runtime/connector-upgrade";
import { ConnectorUpgradeSidebarLink } from "../../../src/components/dashboard/connector-upgrade-badge";
import { HermesUpdateNotice } from "../../../src/screens/settings/installation/cloud/cloud-link-check";

const clients: QueryClient[] = [];

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
});

const available: RuntimeHermesUpdateDto = { current: "0.22.2", latest: "0.22.6", available: true, upgradeCommand: "sudo edge-setup upgrade --yes" };

function link(hermes: RuntimeHermesUpdateDto | null, connector: RuntimeLinkDto["connector"] = null): RuntimeLinkDto {
  return {
    connector, hermesUpdate: hermes, connected: true, lastSeenAt: null, lastReplacedAt: null, hijackSuspectedAt: null,
    rotatedAt: null, origin: null, originRetired: false, relinkCommand: null,
  };
}

test("hermesUpdate keeps only an update compared on both sides", () => {
  expect(hermesUpdate(link(available))).toEqual(available);
  expect(hermesUpdate(link({ ...available, available: false }))).toBeNull();
  // A canary announced by the host comes back as current: null.
  expect(hermesUpdate(link({ ...available, current: null }))).toBeNull();
  expect(hermesUpdate(link(null))).toBeNull();
  expect(hermesUpdate(null)).toBeNull();
});

test("runtime screen: the notice names both versions and the command to run on the host", () => {
  render(<I18nProvider><HermesUpdateNotice link={link(available)} /></I18nProvider>);
  expect(screen.getByRole("status").textContent).toContain("Mise à jour de Hermes disponible");
  expect(screen.getByText("Hermes installé : 0.22.2 · avec la dernière version d’edge-setup : 0.22.6")).toBeTruthy();
  expect(screen.getByText("sudo edge-setup upgrade --yes")).toBeTruthy();
  expect(screen.getByText(/openedbot ne met jamais à jour votre machine lui-même/)).toBeTruthy();
});

test("runtime screen: nothing when Hermes is current, unknown or absent", () => {
  for (const hermes of [{ ...available, available: false }, { ...available, current: null }, null]) {
    const { container } = render(<I18nProvider><HermesUpdateNotice link={link(hermes)} /></I18nProvider>);
    expect(container.textContent).toBe("");
    cleanup();
  }
});

test("runtime screen: English copy", () => {
  window.localStorage.setItem("ohb:locale", "en");
  render(<I18nProvider><HermesUpdateNotice link={link(available)} /></I18nProvider>);
  expect(screen.getByText("Hermes update available")).toBeTruthy();
  expect(screen.getByText("Hermes installed: 0.22.2 · with the latest edge-setup release: 0.22.6")).toBeTruthy();
});

async function renderSidebarLink(runtimeLink: RuntimeLinkDto) {
  const root = createRootRoute({ component: () => <><span>sidebar</span><ConnectorUpgradeSidebarLink className="footer" /></> });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const runtime = createRoute({ getParentRoute: () => root, path: "/settings/runtime", component: () => null });
  const router = createRouter({ routeTree: root.addChildren([index, runtime]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(queryKeys.runtimeConfiguration, { runtime: { id: "rt", name: "Labo", link: runtimeLink } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
  await router.load();
  await screen.findByText("sidebar");
  return view;
}

test("sidebar (desktop and mobile drawer): a Hermes-only update gets the information entry", async () => {
  await renderSidebarLink(link(available));
  const entry = await screen.findByRole("link", { name: "Hermes 0.22.6 est disponible : ouvrir les réglages du runtime" });
  expect(entry.textContent).toContain("Mise à jour de Hermes");
  expect(entry.getAttribute("href")).toContain("/settings/runtime");
});

test("sidebar: the connector entry wins when edge-setup itself is behind, and nothing shows when all is current", async () => {
  const connector = {
    agent: "edge-setup/v0.5.0", version: "v0.5.0", latestVersion: "v0.6.0", minimumVersion: null,
    outdated: false, updateAvailable: true, seenAt: null, upgradeCommand: "sudo edge-setup upgrade --yes" as const,
  };
  await renderSidebarLink(link(available, connector));
  expect((await screen.findByRole("link")).textContent).toContain("Mise à jour du connecteur");
  cleanup();

  const { container } = await renderSidebarLink(link({ ...available, available: false }, { ...connector, updateAvailable: false }));
  expect(container.querySelector("a")).toBeNull();
});
