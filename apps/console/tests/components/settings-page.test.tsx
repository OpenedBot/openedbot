import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { queryKeys } from "../../src/lib/api";
import { I18nProvider } from "../../src/lib/i18n";
import { SETTINGS_OVERLAY_STATE_KEY, useOpenSettings } from "../../src/lib/shell/settings-overlay";

// `mock.module` is process-wide in Bun: keep copies of the real modules and put
// them back after this file, or every later suite renders these fixtures.
const BOARD_FRAME = "../../src/components/boardui/board-frame";
const CONNECTOR_UPDATE = "../../src/components/connector-update-dialog";
const boardFrame = { ...(await import(BOARD_FRAME)) };
const connectorUpdate = { ...(await import(CONNECTOR_UPDATE)) };
afterAll(() => {
  mock.module(BOARD_FRAME, () => boardFrame);
  mock.module(CONNECTOR_UPDATE, () => connectorUpdate);
});

mock.module(BOARD_FRAME, () => ({
  BoardFrame: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
mock.module(CONNECTOR_UPDATE, () => ({
  ConnectorUpdateAnnouncement: () => null,
}));
const { DesktopAppFrame } = await import("../../src/components/frames/app-frame");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderApp(initial = "/") {
  function Conversation() {
    const open = useOpenSettings();
    return <button onClick={() => open("/settings/runtime")}>Open runtime fixture</button>;
  }
  const root = createRootRoute({ component: DesktopAppFrame });
  const conversation = createRoute({ getParentRoute: () => root, path: "/", component: Conversation });
  const runtime = createRoute({
    getParentRoute: () => root,
    path: "/settings/runtime",
    validateSearch: (search: Record<string, unknown>) => ({ section: search.section as string | undefined }),
    component: () => <p>Standalone runtime route</p>,
  });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree: root.addChildren([conversation, runtime]), history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.authMe, { kind: "anonymous" });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
  return { router, client };
}

test("a settings section always opens as a page on its route, never as a window", async () => {
  // Even a device that once chose the window: the choice no longer exists.
  localStorage.setItem("openedbot:settings-display", "modal");
  const { router, client } = renderApp();
  fireEvent.click(await screen.findByText("Open runtime fixture"));
  await screen.findByText("Standalone runtime route");
  expect(router.state.location.pathname).toBe("/settings/runtime");
  expect(router.state.location.maskedLocation).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  client.clear();
});

test("a history entry written by the old window opens that section's route, tab included", async () => {
  const { router, client } = renderApp();
  await screen.findByText("Open runtime fixture");
  // What the window used to push: the real location stays `/`, the state and
  // the mask name the section.
  await router.navigate({
    to: "/",
    state: { [SETTINGS_OVERLAY_STATE_KEY]: "/settings/runtime", openedbotSettingsRuntimeSection: "runtimes" } as never,
    mask: { to: "/settings/runtime", search: { section: "runtimes" } } as never,
  });
  await screen.findByText("Standalone runtime route");
  expect(router.state.location.pathname).toBe("/settings/runtime");
  expect(router.state.location.search).toEqual({ section: "runtimes" });
  expect(screen.queryByRole("dialog")).toBeNull();
  client.clear();
});
