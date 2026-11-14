import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { WorkspaceAccessBoundary } from "../../../src/components/workspace/workspace-access-boundary";
import { queryKeys } from "../../../src/lib/api";
import { reportWorkspaceRevoked, saveCloudSession } from "../../../src/lib/session/cloud-session";
import { I18nProvider } from "../../../src/lib/i18n";
import { rememberWorkspaces } from "../../../src/lib/workspace/workspace-directory";

const workspaceId = "90000000-0000-4000-8000-000000000001";
const otherId = "90000000-0000-4000-8000-000000000002";

beforeEach(() => {
  window.location.href = "http://localhost/o/atelier/settings";
  window.sessionStorage.clear();
  window.localStorage.setItem("openedbot:locale", "fr");
  saveCloudSession({ organizationId: workspaceId, userId: "operator", csrfToken: "fixture-csrf" });
  rememberWorkspaces([
    { id: workspaceId, slug: "atelier", name: "Atelier", kind: "personal", role: "owner" },
    { id: otherId, slug: "second", name: "Second", kind: "personal", role: "member" },
  ], "operator");
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function mount() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = queryKeys.overview;
  cache.setQueryData(key, { caption: "Confidential A", count: 9 });
  function WorkspaceView() {
    const snapshot = useQuery({ queryKey: key, queryFn: async () => ({ caption: "Confidential A", count: 9 }) });
    return <p>{snapshot.data?.caption}: {snapshot.data?.count}</p>;
  }
  render(<QueryClientProvider client={cache}><I18nProvider><WorkspaceAccessBoundary><WorkspaceView /></WorkspaceAccessBoundary></I18nProvider></QueryClientProvider>);
  return cache;
}

test("a refusal clears the measured cache and unmounts the old workspace view before redirect", () => {
  const cache = mount();
  expect(screen.getByText("Confidential A: 9")).toBeTruthy();
  act(() => reportWorkspaceRevoked(workspaceId));
  expect(screen.queryByText("Confidential A: 9")).toBeNull();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(cache.getQueryCache().getAll()).toHaveLength(0);
});

test("a refusal for another organization cannot erase this frame", () => {
  const cache = mount();
  act(() => reportWorkspaceRevoked(otherId));
  expect(screen.getByText("Confidential A: 9")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(cache.getQueryCache().getAll()).toHaveLength(1);
  cache.clear();
});
