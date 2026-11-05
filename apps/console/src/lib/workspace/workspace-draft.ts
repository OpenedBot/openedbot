import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { readCloudSession } from "../session/cloud-session";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";

export function workspaceDraftKey(scope: string): string | null {
  const session = readCloudSession();
  return session?.userId && session.organizationId ? `openedbot:draft:${session.userId}:${session.organizationId}:${scope}` : null;
}

/**
 * Where a draft lives. Text survives closing the tab (`local`), like any chat
 * app; attachments carry base64 content that would exhaust the origin's
 * localStorage quota, so they stay with the tab (`session`). Sign-out
 * removes every text draft (`clearWorkspaceDrafts`): a shared device must
 * not show the previous operator's words.
 */
type DraftStorage = "local" | "session";

function draftStore(storage: DraftStorage): Storage {
  return storage === "local" ? window.localStorage : window.sessionStorage;
}

export function readWorkspaceDraft<T>(key: string | null, fallback: T, validate: (value: unknown) => value is T, storage: DraftStorage = "session"): T {
  try {
    if (!key) return fallback;
    // A text draft written before drafts moved to localStorage still sits in
    // this tab's sessionStorage: read it rather than lose it.
    const raw = draftStore(storage).getItem(key) ?? (storage === "local" ? window.sessionStorage.getItem(key) : null);
    const value: unknown = JSON.parse(raw ?? "null");
    return validate(value) ? value : fallback;
  } catch { return fallback; }
}

/** Sign-out: forget every text draft kept on this device, all users included. */
export function clearWorkspaceDrafts(): void {
  try {
    const store = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith("openedbot:draft:")) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch { /* Storage unavailable: nothing was kept there either. */ }
}

function useWorkspaceDraft<T>(scope: string, initial: T, validate: (value: unknown) => value is T, storage: DraftStorage): [T, Dispatch<SetStateAction<T>>] {
  const key = workspaceDraftKey(scope);
  const [state, setState] = useState(() => ({ key, value: readWorkspaceDraft(key, initial, validate, storage) }));
  const [unpersisted, setUnpersisted] = useState(false);
  // What this tab last read or wrote under the key. Another tab on the same
  // conversation shares the localStorage key: clearing compares first, so a
  // send here never erases the draft that tab saved since. Until this tab
  // edits under the key, the shown value is reread from storage on every
  // render, and the snapshot follows it.
  const synced = useRef<{ key: string | null; raw: string | null }>({ key: null, raw: null });
  if (synced.current.key !== key || state.key !== key) {
    let raw: string | null = null;
    try { raw = key ? draftStore(storage).getItem(key) : null; } catch { /* Read failures already fall back to the initial value. */ }
    synced.current = { key, raw };
  }
  const value = state.key === key ? state.value : readWorkspaceDraft(key, initial, validate, storage);
  useEffect(() => {
    if (!unpersisted) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [unpersisted]);
  const set: Dispatch<SetStateAction<T>> = (next) => {
    const resolved = typeof next === "function" ? (next as (value: T) => T)(value) : next;
    setState({ key, value: resolved });
    try {
      if (key) {
        const serialized = JSON.stringify(resolved);
        // An emptied draft leaves no key behind (sent drafts never pile up),
        // unless another tab wrote its own draft there since this one synced.
        if (serialized === JSON.stringify(initial)) {
          const stored = draftStore(storage).getItem(key);
          if (stored === null || stored === synced.current.raw) draftStore(storage).removeItem(key);
          synced.current = { key, raw: null };
        } else {
          draftStore(storage).setItem(key, serialized);
          synced.current = { key, raw: serialized };
        }
        if (storage === "local") window.sessionStorage.removeItem(key);
      } else if (JSON.stringify(resolved) !== JSON.stringify(initial)) throw new Error("Draft has no persistence scope");
      setUnpersisted(false);
    } catch {
      setUnpersisted(true);
    }
  };
  return [value, set];
}

const isText = (value: unknown): value is string => typeof value === "string";
const isAttachments = (value: unknown): value is MessageAttachmentInput[] => Array.isArray(value) && value.length <= 5
  && value.every((item) => item && typeof item === "object" && typeof item.name === "string"
    && typeof item.contentType === "string" && ["image", "document"].includes(item.kind)
    && Array.isArray(item.content) && item.content.every((part: Record<string, unknown>) => part && typeof part === "object"
      && ((part.type === "text" && typeof part.text === "string") || (part.type === "image" && typeof part.image === "string"))));

export function useWorkspaceTextDraft(scope: string) { return useWorkspaceDraft(`${scope}:text`, "", isText, "local"); }
export function useWorkspaceAttachmentDraft(scope: string) { return useWorkspaceDraft<MessageAttachmentInput[]>(`${scope}:attachments`, [], isAttachments, "session"); }
