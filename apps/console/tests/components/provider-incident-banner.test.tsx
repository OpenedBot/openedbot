import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RuntimeProviderIncidentDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { ProviderIncidentDialog } from "../../src/components/provider-incident-banner";

// Ces cas vérifient une copie FRANÇAISE : la langue est posée explicitement,
// le défaut du produit étant désormais l'anglais (`DEFAULT_LOCALE`).
beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => cleanup());

const incident: RuntimeProviderIncidentDto = {
  provider: "openai-codex",
  kind: "quota",
  firstSeenAt: "2026-09-04T20:03:00.000Z",
  lastSeenAt: "2026-09-04T20:03:00.000Z",
  until: "2099-01-01T00:00:00.000Z",
  fallbackProvider: "opencode-free",
  fallbackModel: "nemotron",
  message: null,
};

function renderBanner(incidents: RuntimeProviderIncidentDto[]) {
  const root = createRootRoute({
    component: () => <ProviderIncidentDialog incidents={incidents} />,
  });
  const models = createRoute({ getParentRoute: () => root, path: "/settings/models", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([models]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <I18nProvider>
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

describe("ProviderIncidentDialog", () => {
  test("names the provider, fallback and reconnect action", async () => {
    renderBanner([incident]);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/openai-codex/)).toBeTruthy();
    expect(screen.getByText(/opencode-free \/ nemotron/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reconnecter" }).getAttribute("href")).toBe("/settings/models");
  });

  test("hides expired incidents", () => {
    renderBanner([{ ...incident, until: "2000-01-01T00:00:00.000Z" }]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
