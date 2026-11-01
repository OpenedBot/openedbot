import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { queryKeys } from "../../src/lib/api";
import { I18nProvider } from "../../src/lib/i18n";
import { useOpenSettings } from "../../src/lib/shell/settings-overlay";
import { setSettingsDisplay } from "../../src/lib/shell/settings-display";

// `mock.module` is process-wide in Bun: keep copies of the real modules and put
// them back after this file, or every later suite renders these fixtures.
const BOARD_FRAME = "../../src/components/boardui/board-frame";
const CONNECTOR_UPDATE = "../../src/components/connector-update-dialog";
const CLOUD = "../../src/screens/settings/installation/cloud";
const boardFrame = { ...(await import(BOARD_FRAME)) };
const connectorUpdate = { ...(await import(CONNECTOR_UPDATE)) };
const cloud = { ...(await import(CLOUD)) };
afterAll(() => {
  mock.module(BOARD_FRAME, () => boardFrame);
  mock.module(CONNECTOR_UPDATE, () => connectorUpdate);
  mock.module(CLOUD, () => cloud);
});

mock.module(BOARD_FRAME, () => ({
  BoardFrame: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
mock.module(CONNECTOR_UPDATE, () => ({
  ConnectorUpdateAnnouncement: () => null,
}));
mock.module(CLOUD, () => ({
  ...cloud,
  CloudSettingsOverview: () => <p>Overview fixture</p>,
  CloudRuntimeSettings: ({ section, onSectionChange }: {
    section?: string; onSectionChange?: (section: "runtimes") => void;
  }) => (
    <div>
      <p>Edge section: {section ?? "status"}</p>
      <input aria-label="Unsaved runtime value" defaultValue="" />
      <button onClick={() => onSectionChange?.("runtimes")}>Runtime tab fixture</button>
    </div>
  ),
}));
const { DesktopAppFrame } = await import("../../src/components/frames/app-frame");

afterEach(() => {
  cleanup();
  setSettingsDisplay("modal");
  localStorage.clear();
});

test("opening Runtime and switching tabs preserves the app, modal and runtime form", async () => {
  let mounts = 0;
  let unmounts = 0;
  function Conversation() {
    const open = useOpenSettings();
    useEffect(() => {
      mounts++;
      return () => { unmounts++; };
    }, []);
    return <button onClick={() => open()}>Open settings fixture</button>;
  }
  const root = createRootRoute({ component: DesktopAppFrame });
  const conversation = createRoute({ getParentRoute: () => root, path: "/", component: Conversation });
  const runtime = createRoute({
    getParentRoute: () => root,
    path: "/settings/runtime",
    validateSearch: (search: Record<string, unknown>) => ({ section: search.section as string | undefined }),
    component: () => <p>Standalone runtime route</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routeTree: root.addChildren([conversation, runtime]), history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.authMe, { kind: "anonymous" });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByText("Open settings fixture"));
  const modal = await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("link", { name: "Runtime" }));
  await screen.findByText("Edge section: status");
  expect(screen.getByRole("dialog")).toBe(modal);
  expect(router.state.location.pathname).toBe("/");
  expect(router.state.location.maskedLocation?.pathname).toBe("/settings/runtime");
  expect(mounts).toBe(1);
  expect(unmounts).toBe(0);
  expect(screen.queryByText("Standalone runtime route")).toBeNull();

  const field = screen.getByRole("textbox", { name: "Unsaved runtime value" });
  fireEvent.change(field, { target: { value: "keep this" } });
  fireEvent.click(screen.getByText("Runtime tab fixture"));
  await screen.findByText("Edge section: runtimes");
  expect(router.state.location.maskedLocation?.search.section).toBe("runtimes");
  expect(screen.getByRole("textbox", { name: "Unsaved runtime value" })).toBe(field);
  expect((field as HTMLInputElement).value).toBe("keep this");
  expect(screen.getByRole("dialog")).toBe(modal);
  expect(unmounts).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(router.state.location.pathname).toBe("/");
  expect(mounts).toBe(1);
  client.clear();
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

test("« Page » : a section opens on its route, without the overlay", async () => {
  setSettingsDisplay("page");
  const { router, client } = renderApp();
  fireEvent.click(await screen.findByText("Open runtime fixture"));
  await screen.findByText("Standalone runtime route");
  expect(router.state.location.pathname).toBe("/settings/runtime");
  expect(router.state.location.maskedLocation).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  client.clear();
});

test("« Open as a page » from the window remembers the choice and leaves for the route", async () => {
  const { router, client } = renderApp();
  fireEvent.click(await screen.findByText("Open runtime fixture"));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Open as a page" }));
  await screen.findByText("Standalone runtime route");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(router.state.location.pathname).toBe("/settings/runtime");
  expect(localStorage.getItem("ohb:settings-display")).toBe("page");
  client.clear();
});

test("« Page » : an entry still carrying a window's overlay opens that section's route, not the screen behind", async () => {
  // A window was open on this entry, then the mode became « Page » (another
  // tab, or a reload after the switch): the history state still names the
  // section while the real route is the screen behind it.
  const { router, client } = renderApp();
  fireEvent.click(await screen.findByText("Open runtime fixture"));
  await screen.findByRole("dialog");
  setSettingsDisplay("page");
  await screen.findByText("Standalone runtime route");
  expect(router.state.location.pathname).toBe("/settings/runtime");
  expect(router.state.location.maskedLocation).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  client.clear();
});
