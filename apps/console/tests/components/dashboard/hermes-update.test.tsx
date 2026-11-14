import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RuntimeHermesUpdateDto, RuntimeLinkDto } from "@openedbot/contracts-api";
import { queryKeys } from "../../../src/lib/api";
import { I18nProvider } from "../../../src/lib/i18n";
import { hermesUpdate, hermesVersionState } from "../../../src/lib/runtime/connector-upgrade";
import { RuntimeVersionRows } from "../../../src/screens/settings/installation/cloud/cloud-versions";
import { ConnectorUpgradeSidebarLink } from "../../../src/components/dashboard/connector-upgrade-badge";
import { HermesUpdateNotice } from "../../../src/screens/settings/installation/cloud/cloud-link-check";

const clients: QueryClient[] = [];

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
});

const available: RuntimeHermesUpdateDto = {
  current: "0.22.2", latest: "0.22.6", available: true,
  upgradeCommand: "sudo edge-setup upgrade --yes", upCommand: "sudo edge-setup up --yes",
};

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

test("runtime screen: edge-setup current, the notice hands out `up`, the command that installs Hermes", () => {
  render(<I18nProvider><HermesUpdateNotice link={link(available, connector())} /></I18nProvider>);
  expect(screen.getByRole("status").textContent).toContain("Mise à jour de Hermes disponible");
  expect(screen.getByText("Hermes installé : 0.22.2 · avec la dernière version d’edge-setup : 0.22.6")).toBeTruthy();
  expect(screen.getByText("Installer Hermes 0.22.6")).toBeTruthy();
  expect(screen.getByText("sudo edge-setup up --yes")).toBeTruthy();
  // `upgrade` replaces the binary and leaves Hermes as it is: never offered alone.
  expect(screen.queryByText("sudo edge-setup upgrade --yes")).toBeNull();
  expect(screen.getByText(/c’est « up » qui l’installe/)).toBeTruthy();
  expect(screen.getByText(/openedbot ne met jamais à jour votre machine lui-même/)).toBeTruthy();
});

test("runtime screen: edge-setup behind, the notice gives upgrade first, then up", () => {
  render(<I18nProvider><HermesUpdateNotice link={link(available, connector({ latestVersion: "1.5.4", updateAvailable: true }))} /></I18nProvider>);
  const text = screen.getByRole("status").textContent ?? "";
  expect(screen.getByText("1. Mettre à jour edge-setup")).toBeTruthy();
  expect(screen.getByText("2. Installer Hermes 0.22.6")).toBeTruthy();
  expect(text.indexOf("sudo edge-setup upgrade --yes")).toBeLessThan(text.indexOf("sudo edge-setup up --yes"));
  expect(text.indexOf("sudo edge-setup upgrade --yes")).toBeGreaterThan(-1);
});

test("runtime screen: an API without upCommand still hands out `up`", () => {
  const { upCommand: _dropped, ...older } = available;
  render(<I18nProvider><HermesUpdateNotice link={link(older as RuntimeHermesUpdateDto)} /></I18nProvider>);
  expect(screen.getByText("sudo edge-setup up --yes")).toBeTruthy();
});

test("runtime screen: nothing when Hermes is current, unknown or absent", () => {
  for (const hermes of [{ ...available, available: false }, { ...available, current: null }, null]) {
    const { container } = render(<I18nProvider><HermesUpdateNotice link={link(hermes)} /></I18nProvider>);
    expect(container.textContent).toBe("");
    cleanup();
  }
});

test("runtime screen: English copy", () => {
  window.localStorage.setItem("openedbot:locale", "en");
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

test("hermesVersionState: unknown, up to date or behind", () => {
  expect(hermesVersionState(link(available))).toEqual({ kind: "behind", version: "0.22.2", latest: "0.22.6", upstream: null });
  expect(hermesVersionState(link({ ...available, available: false }))).toEqual({ kind: "current", version: "0.22.2", upstream: null });
  expect(hermesVersionState(link({ ...available, available: false, upstream: "0.23.0" })))
    .toEqual({ kind: "current", version: "0.22.2", upstream: "0.23.0" });
  expect(hermesVersionState(link({ ...available, current: null, available: false }))).toEqual({ kind: "unknown", upstream: null });
  expect(hermesVersionState(link(null))).toEqual({ kind: "unknown", upstream: null });
  expect(hermesVersionState(null)).toEqual({ kind: "unknown", upstream: null });
});

const connector = (over: Partial<NonNullable<RuntimeLinkDto["connector"]>> = {}): RuntimeLinkDto["connector"] => ({
  agent: "edge-setup/v1.5.3", version: "1.5.3", latestVersion: "1.5.3", minimumVersion: null, outdated: false,
  updateAvailable: false, seenAt: null, upgradeCommand: "sudo edge-setup upgrade --yes", ...over,
});

test("runtime screen: the version rows always say edge-setup and Hermes", () => {
  render(<I18nProvider><RuntimeVersionRows link={link({ ...available, available: false }, connector())} /></I18nProvider>);
  expect(screen.getByText("1.5.3 · à jour")).toBeTruthy();
  expect(screen.getByText("0.22.2 · à jour")).toBeTruthy();
  cleanup();
  render(<I18nProvider><RuntimeVersionRows link={link(available, connector({ latestVersion: "1.5.4", updateAvailable: true }))} /></I18nProvider>);
  expect(screen.getByText("1.5.3 · 1.5.4 disponible")).toBeTruthy();
  expect(screen.getByText("0.22.2 · 0.22.6 disponible")).toBeTruthy();
  cleanup();
  render(<I18nProvider><RuntimeVersionRows link={link({ ...available, current: null, available: false }, connector({ version: null }))} /></I18nProvider>);
  expect(screen.getAllByText("version inconnue")).toHaveLength(2);
  cleanup();
  render(<I18nProvider><RuntimeVersionRows link={link({ ...available, latest: "0.22.2", available: false, upstream: "0.23.0" }, connector())} /></I18nProvider>);
  expect(screen.getByText("0.22.2 · à jour")).toBeTruthy();
  expect(screen.getByText("0.23.0 publiée par Hermes, en cours de validation")).toBeTruthy();
});
