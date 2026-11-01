import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccountWorkspace } from "@openedbot/contracts-api";
import { fleetAccountInPath, internalWorkspacePath, isOnboardingPath, isWorkspacePath, operatingFleetId, workspaceHref, workspaceInPath, workspaceRewriteInput } from "../../../src/lib/workspace/workspace-location";
import { rememberWorkspaces } from "../../../src/lib/workspace/workspace-directory";

const id = "83000000-0000-4000-8000-000000000001";
const fleetId = "83000000-0000-4000-8000-000000000002";

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
    expect(internalWorkspacePath("/agency")).toBe("/agency");
    expect(internalWorkspacePath("/bot/a")).toBe("/bot/a");
    expect(workspaceInPath("/o/not_a_tenant/bot/a")).toBeNull();
    expect(isOnboardingPath("/onboarding")).toBe(true);
    expect(isOnboardingPath("/onboarding/organization")).toBe(true);
    expect(isWorkspacePath("/onboarding")).toBe(false);
    expect(isWorkspacePath("/settings")).toBe(true);
    expect(isWorkspacePath("/summary")).toBe(true);
    expect(isWorkspacePath("/conversations")).toBe(true);
  });
  test("agency account paths cover every own-settings page", () => {
    rememberWorkspaces([
      { id: fleetId, slug: "demo-agency", name: "Demo Agency", kind: "agency", role: "owner" },
    ], "operator");
    expect(fleetAccountInPath("/o/demo-agency/settings/team")).toBe("demo-agency");
    expect(fleetAccountInPath("/o/demo-agency/settings/profile")).toBe("demo-agency");
    expect(fleetAccountInPath("/o/demo-agency/settings/appearance")).toBe("demo-agency");
    expect(fleetAccountInPath("/o/demo-agency/settings/notifications")).toBe("demo-agency");
    expect(fleetAccountInPath("/o/demo-agency/settings/security")).toBe("demo-agency");
    expect(fleetAccountInPath("/o/demo-agency/settings/runtime")).toBeNull();
  });
  test("cross-origin destinations are not accepted", () => {
    expect(workspaceHref(id, "//evil.test")).toBe("/home");
    expect(workspaceHref("invalid", "/")).toBe("/home");
  });
  test("a client with direct access has distinct personal and agency destinations", () => {
    rememberWorkspaces([
      { id, slug: "atelier", name: "Atelier", kind: "personal", role: "owner", viaAgencyIds: [fleetId] },
      { id: fleetId, slug: "studio", name: "Studio", kind: "agency", role: "owner" },
    ], "operator");
    expect(workspaceHref(id, "/settings/policies", fleetId)).toBe("/o/studio/clients/atelier/settings/policies");
    expect(workspaceHref(id, "/settings/policies", null)).toBe("/o/atelier/settings/policies");
    expect(workspaceHref(id, "/")).toBe("/o/atelier/");
  });
  test("an explicit ungranted agency cannot select the first mandate or direct privileges", () => {
    const otherFleetId = "83000000-0000-4000-8000-000000000003";
    const client: AccountWorkspace = { id, slug: "atelier", name: "Atelier", kind: "personal", role: "agency", viaAgencyIds: [fleetId] };
    rememberWorkspaces([
      client,
      { id: fleetId, slug: "studio", name: "Studio", kind: "agency", role: "owner" },
      { id: otherFleetId, slug: "second", name: "Second", kind: "agency", role: "owner" },
    ], "operator");
    expect(operatingFleetId(client, otherFleetId)).toBeNull();
    expect(workspaceHref(id, "/settings/agents", otherFleetId)).toBe("/home");
    window.history.replaceState(null, "", "/o/second/clients/atelier/settings/agents");
    expect(operatingFleetId(client)).toBeNull();
    expect(workspaceHref(id, "/settings/agents")).toBe("/home");
    expect(workspaceHref(id, "/settings/agents", null)).toBe("/home");
    window.history.replaceState(null, "", "/o/unknown-agency/clients/atelier/settings/agents");
    expect(operatingFleetId(client)).toBeNull();
    expect(workspaceHref(id, "/settings/agents")).toBe("/home");
    expect(workspaceHref(id, "/settings/agents", fleetId)).toBe("/o/studio/clients/atelier/settings/agents");
  });
  test("an empty grant list never treats a preferred agency as authorized", () => {
    expect(operatingFleetId({}, fleetId)).toBeNull();
    expect(operatingFleetId({ viaAgencyIds: [] }, fleetId)).toBeNull();
    expect(operatingFleetId({ viaAgencyIds: [fleetId] })).toBe(fleetId);
  });
});
