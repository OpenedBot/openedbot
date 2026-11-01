import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { readCloudSession, saveCloudSession, syncCloudSession } from "../../src/lib/cloud-session";
import { clearWorkspaceDrafts, useWorkspaceAttachmentDraft, useWorkspaceTextDraft } from "../../src/lib/workspace-draft";

afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe("per-user and per-client drafts", () => {
  test("opening another client preserves the first draft without showing it", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => first.result.current[1]("For client A"));
    first.unmount();
    syncCloudSession({ organizationId: "b", csrfToken: "csrf", userId: "operator" });
    const second = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(second.result.current[0]).toBe("");
    act(() => second.result.current[1]("For client B"));
    second.unmount();
    syncCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const back = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(back.result.current[0]).toBe("For client A");
  });
  test("another user cannot inherit the previous user's draft", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "first" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => first.result.current[1]("Private draft")); first.unmount();
    saveCloudSession({ organizationId: "a", csrfToken: "new-csrf", userId: "second" });
    expect(renderHook(() => useWorkspaceTextDraft("bot:one")).result.current[0]).toBe("");
  });
  test("a workspace selection does not rewrite the shared identity mirror", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    syncCloudSession({ organizationId: "b", csrfToken: "csrf", userId: "operator" });
    expect(readCloudSession()?.organizationId).toBe("b");
    expect(JSON.parse(window.localStorage.getItem("ohb:cloud-session")!).organizationId).toBe("a");
  });
});

describe("draft durability", () => {
  test("a text draft survives closing the tab (a new tab has an empty sessionStorage)", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => first.result.current[1]("Kept after closing"));
    first.unmount();
    window.sessionStorage.clear();
    expect(renderHook(() => useWorkspaceTextDraft("bot:one")).result.current[0]).toBe("Kept after closing");
  });
  test("sending from one tab never erases the draft another tab saved since", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const tabA = renderHook(() => useWorkspaceTextDraft("bot:one"));
    const tabB = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => tabA.result.current[1]("Draft from A"));
    act(() => tabB.result.current[1]("Draft from B"));
    act(() => tabA.result.current[1](""));
    tabA.unmount(); tabB.unmount();
    expect(renderHook(() => useWorkspaceTextDraft("bot:one")).result.current[0]).toBe("Draft from B");
  });
  test("sending a draft another tab saved after a scope switch leaves no key behind", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const tabA = renderHook(({ scope }) => useWorkspaceTextDraft(scope), { initialProps: { scope: "bot:one" } });
    tabA.rerender({ scope: "bot:two" });
    const tabB = renderHook(() => useWorkspaceTextDraft("bot:two"));
    act(() => tabB.result.current[1]("Draft from B"));
    tabB.unmount();
    tabA.rerender({ scope: "bot:two" });
    expect(tabA.result.current[0]).toBe("Draft from B");
    act(() => tabA.result.current[1](""));
    tabA.unmount();
    expect(renderHook(() => useWorkspaceTextDraft("bot:two")).result.current[0]).toBe("");
  });
  test("an emptied draft leaves no key behind", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => draft.result.current[1]("Sent soon"));
    act(() => draft.result.current[1](""));
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("ohb:draft:"))).toEqual([]);
  });
  test("attachments stay with the tab, never in localStorage", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    act(() => draft.result.current[1]([{ name: "a.txt", contentType: "text/plain", kind: "document", content: [{ type: "text", text: "x" }] }]));
    expect(Object.keys(window.localStorage).some((key) => key.startsWith("ohb:draft:"))).toBe(false);
    expect(Object.keys(window.sessionStorage).some((key) => key.endsWith(":attachments"))).toBe(true);
  });
  test("sign-out forgets every text draft on the device", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => draft.result.current[1]("Private words"));
    window.localStorage.setItem("ohb:locale", "fr");
    clearWorkspaceDrafts();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("ohb:draft:"))).toEqual([]);
    expect(window.localStorage.getItem("ohb:locale")).toBe("fr");
  });
});
