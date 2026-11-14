import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { readCloudSession, saveCloudSession, syncCloudSession } from "../../../src/lib/session/cloud-session";
import { clearWorkspaceDrafts, useWorkspaceAttachmentDraft, useWorkspaceTextDraft } from "../../../src/lib/workspace/workspace-draft";

afterEach(() => { cleanup(); clearWorkspaceDrafts(); window.localStorage.clear(); window.sessionStorage.clear(); });

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
    expect(JSON.parse(window.localStorage.getItem("openedbot:cloud-session")!).organizationId).toBe("a");
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
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("openedbot:draft:"))).toEqual([]);
  });
  test("attachments stay with the tab, never in localStorage", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    act(() => draft.result.current[1]([{ name: "a.txt", contentType: "text/plain", kind: "document", content: [{ type: "text", text: "x" }] }]));
    expect(Object.keys(window.localStorage).some((key) => key.startsWith("openedbot:draft:"))).toBe(false);
    expect(Object.keys(window.sessionStorage).some((key) => key.endsWith(":attachments"))).toBe(true);
  });
  test("sign-out forgets every text draft on the device", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => draft.result.current[1]("Private words"));
    window.localStorage.setItem("openedbot:locale", "fr");
    clearWorkspaceDrafts();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("openedbot:draft:"))).toEqual([]);
    expect(window.localStorage.getItem("openedbot:locale")).toBe("fr");
  });
});


describe("draft persistence status", () => {
  test("a failed write preserves text, protects closing, and retries on the next edit", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(draft.result.current[2]).toBe(false);
    const restore = failDraftWrites("localStorage");
    try {
      act(() => draft.result.current[1]("Still here"));
      expect(draft.result.current[0]).toBe("Still here");
      expect(draft.result.current[2]).toBe(true);
      const closing = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(closing);
      expect(closing.defaultPrevented).toBe(true);
    } finally { restore(); }
    act(() => draft.result.current[1]("Still here, edited"));
    expect(draft.result.current[2]).toBe(false);
    const closing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
    expect(window.localStorage.getItem("openedbot:draft:operator:a:bot:one:text")).toBe(JSON.stringify("Still here, edited"));
  });

  test("attachment quota failure preserves the attachment and clears after a successful retry", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    const attachments = [{ name: "a.txt", contentType: "text/plain", kind: "document" as const, content: [{ type: "text" as const, text: "x" }] }];
    const restore = failDraftWrites("sessionStorage");
    try {
      act(() => draft.result.current[1](attachments));
      expect(draft.result.current[0]).toEqual(attachments);
      expect(draft.result.current[2]).toBe(true);
    } finally { restore(); }
    act(() => draft.result.current[1]([...attachments]));
    expect(draft.result.current[2]).toBe(false);
  });

  test("a failure does not leak into another conversation or its close protection", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const draft = renderHook(({ scope }) => useWorkspaceTextDraft(scope), { initialProps: { scope: "bot:one" } });
    const restore = failDraftWrites("localStorage");
    try {
      act(() => draft.result.current[1]("Unsaved"));
      expect(draft.result.current[2]).toBe(true);
      draft.rerender({ scope: "bot:two" });
      expect(draft.result.current[0]).toBe("");
      expect(draft.result.current[2]).toBe(false);
      const closing = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(closing);
      expect(closing.defaultPrevented).toBe(false);
      draft.rerender({ scope: "bot:one" });
      expect(draft.result.current[0]).toBe("Unsaved");
      expect(draft.result.current[2]).toBe(true);
    } finally { restore(); }
  });
});

function failDraftWrites(name: "localStorage" | "sessionStorage"): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, name)!;
  const storage = window[name];
  Object.defineProperty(window, name, { configurable: true, value: {
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem() { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
  } });
  return () => Object.defineProperty(window, name, descriptor);
}


describe("failed drafts survive composer remounts", () => {
  test("remount keeps failed text over stale storage and recovery removes the memory fallback", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    act(() => first.result.current[1]("Old saved text"));
    const restore = failDraftWrites("localStorage");
    try { act(() => first.result.current[1]("Latest unsaved text")); }
    finally { restore(); }
    first.unmount();
    const remounted = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(remounted.result.current[0]).toBe("Latest unsaved text");
    expect(remounted.result.current[2]).toBe(true);
    act(() => remounted.result.current[1]("Recovered text"));
    expect(remounted.result.current[2]).toBe(false);
    remounted.unmount();
    // A later external edit must be read from storage, not a stale memory copy.
    window.localStorage.setItem("openedbot:draft:operator:a:bot:one:text", JSON.stringify("Other tab"));
    const recovered = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(recovered.result.current[0]).toBe("Other tab");
    expect(recovered.result.current[2]).toBe(false);
  });

  test("remount keeps failed attachments and successful clearing removes the fallback", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    const attachments = [{ name: "a.txt", contentType: "text/plain", kind: "document" as const, content: [{ type: "text" as const, text: "x" }] }];
    const restore = failDraftWrites("sessionStorage");
    try { act(() => first.result.current[1](attachments)); }
    finally { restore(); }
    first.unmount();
    const remounted = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    expect(remounted.result.current[0]).toEqual(attachments);
    expect(remounted.result.current[2]).toBe(true);
    act(() => remounted.result.current[1]([]));
    remounted.unmount();
    const cleared = renderHook(() => useWorkspaceAttachmentDraft("bot:one"));
    expect(cleared.result.current[0]).toEqual([]);
    expect(cleared.result.current[2]).toBe(false);
  });

  test("failed drafts stay private to the user, workspace, and conversation", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    const restore = failDraftWrites("localStorage");
    try { act(() => first.result.current[1]("Private unsaved text")); }
    finally { restore(); }
    first.unmount();
    for (const [userId, organizationId, scope] of [["other", "a", "bot:one"], ["operator", "b", "bot:one"], ["operator", "a", "bot:two"]] as const) {
      saveCloudSession({ userId, organizationId, csrfToken: "csrf" });
      const other = renderHook(() => useWorkspaceTextDraft(scope));
      expect(other.result.current[0]).toBe("");
      expect(other.result.current[2]).toBe(false);
      other.unmount();
    }
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const back = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(back.result.current[0]).toBe("Private unsaved text");
    expect(back.result.current[2]).toBe(true);
  });

  test("sign-out clears failed drafts even when browser storage is inaccessible", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
    const first = renderHook(() => useWorkspaceTextDraft("bot:one"));
    const restore = failDraftWrites("localStorage");
    try { act(() => first.result.current[1]("Private unsaved text")); }
    finally { restore(); }
    first.unmount();
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
    try { clearWorkspaceDrafts(); }
    finally { Object.defineProperty(window, "localStorage", descriptor); }
    const remounted = renderHook(() => useWorkspaceTextDraft("bot:one"));
    expect(remounted.result.current[0]).toBe("");
    expect(remounted.result.current[2]).toBe(false);
  });
});
