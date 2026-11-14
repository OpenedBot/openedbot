import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { internalWorkspacePath, isOnboardingPath, isWorkspacePath, workspaceHref, workspaceInPath, workspaceRewriteInput } from "../../../src/lib/workspace/workspace-location";
import { personalWorkspaces, rememberWorkspaces } from "../../../src/lib/workspace/workspace-directory";

const id = "83000000-0000-4000-8000-000000000001";

beforeEach(() => { window.location.href = "http://localhost/"; });
afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("workspace route isolation", () => {
  test("canonical URLs reuse the existing routes without losing query or hash", () => {
    const url = workspaceRewriteInput({ url: new URL(`https://console.test/o/${id}/bot/a?session=2#message`) });
    expect(url.pathname).toBe("/bot/a");
    expect(url.search).toBe("?session=2");
    expect(url.hash).toBe("#message");
    expect(workspaceInPath(`/o/${id}/bot/a`)).toBe(id);
    expect(workspaceHref(id, "/settings/policies")).toBe(`/o/${id}/settings/policies`);
    expect(workspaceHref(id, "/onboarding")).toBe("/onboarding");
  });
  test("an old workspace-prefixed onboarding URL is matched as the global route", () => {
    const url = workspaceRewriteInput({ url: new URL(`https://console.test/o/${id}/onboarding?step=welcome`) });
    expect(url.pathname).toBe("/onboarding");
    expect(url.search).toBe("?step=welcome");
  });
  test("global and legacy URLs remain intact", () => {
    expect(internalWorkspacePath("/bot/a")).toBe("/bot/a");
    expect(workspaceInPath("/o/not_a_tenant/bot/a")).toBeNull();
    expect(isOnboardingPath("/onboarding")).toBe(true);
    expect(isWorkspacePath("/onboarding")).toBe(false);
    expect(isWorkspacePath("/settings")).toBe(true);
    expect(isWorkspacePath("/summary")).toBe(false);
  });
  test("a nested path under an organization stays that organization's internal path", () => {
    expect(workspaceInPath("/o/atelier/clients/other/settings")).toBe("atelier");
    expect(internalWorkspacePath("/o/atelier/clients/other/settings")).toBe("/clients/other/settings");
  });
  test("cross-origin destinations are not accepted", () => {
    expect(workspaceHref(id, "//evil.test")).toBe("/home");
    expect(workspaceHref("invalid", "/")).toBe("/home");
  });
  test("a known organization is addressed by its slug", () => {
    rememberWorkspaces([{ id, slug: "atelier", name: "Atelier", kind: "personal", role: "owner" }], "operator");
    expect(workspaceHref(id, "/settings/policies")).toBe("/o/atelier/settings/policies");
    expect(workspaceHref(id, "/")).toBe("/o/atelier/");
  });
  test("only personal memberships are kept, without fields the console does not read", () => {
    const listed = [
      { id, slug: "atelier", name: "Atelier", kind: "personal", role: "owner", extra: ["x"] },
      { id: "83000000-0000-4000-8000-000000000002", slug: "shared", name: "Shared", kind: "personal", role: "member" },
      { id: "83000000-0000-4000-8000-000000000003", slug: "delegated", name: "Delegated", kind: "personal", role: "operator" },
      { id: "83000000-0000-4000-8000-000000000004", slug: "studio", name: "Studio", kind: "team", role: "owner" },
    ] as unknown as Parameters<typeof personalWorkspaces>[0];
    expect(personalWorkspaces(listed).map((workspace) => workspace.slug)).toEqual(["atelier", "shared"]);
    expect(personalWorkspaces(listed)[0]).toEqual({ id, slug: "atelier", name: "Atelier", kind: "personal", role: "owner" });
  });
});
