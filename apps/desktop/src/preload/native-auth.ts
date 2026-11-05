import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { NativeAuthBridge, SigninState } from "../shared/bridge";
import { CHANNEL } from "./channels";

// `__OPENEDBOT_NATIVE__.auth`: the console's /login drives the shell's sign-in
// through it. The main process re-checks every call (sender and arguments);
// the page only gets plain copies of the states, never the IPC event.

// A fresh plain object with the known fields only: what crosses to the page
// is data, whatever the main process put next to it.
function toSigninState(raw: unknown): SigninState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  switch (value.status) {
    case "idle":
      return value.reason === "signed-out" || value.reason === "session-lost" ? { status: "idle", reason: value.reason } : { status: "idle" };
    case "waiting":
    case "submitting":
    case "code_required":
    case "sending":
    case "verifying":
      return { status: value.status };
    case "code_sent":
      return typeof value.email === "string" ? { status: "code_sent", email: value.email } : null;
    case "error": {
      if (typeof value.code !== "string" || typeof value.message !== "string") return null;
      const params =
        typeof value.params === "object" && value.params !== null
          ? Object.fromEntries(Object.entries(value.params).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : undefined;
      return { status: "error", code: value.code, message: value.message, ...(params ? { params } : {}) };
    }
    default:
      return null;
  }
}

// The listener is page code: a throw there must not stop the next listener.
function deliver(listener: (state: SigninState) => void, state: SigninState): void {
  try {
    listener(state);
  } catch (error) {
    console.error("openedbot: a sign-in state listener threw", error);
  }
}

export function createNativeAuthBridge(): NativeAuthBridge {
  // Registered with the preload, before any page script: the main process
  // pushes the state on dom-ready, possibly before the page subscribes.
  let lastState: SigninState | null = null;
  ipcRenderer.on(CHANNEL.authState, (_event: IpcRendererEvent, raw: unknown) => {
    lastState = toSigninState(raw) ?? lastState;
  });

  return {
    requestEmailCode: (email, locale) => ipcRenderer.invoke(CHANNEL.authEmailCode, email, locale) as Promise<void>,
    verifyEmailCode: (email, code) => ipcRenderer.invoke(CHANNEL.authEmailVerify, email, code) as Promise<void>,
    startGoogle: () => ipcRenderer.invoke(CHANNEL.authStart) as Promise<void>,
    cancel: () => ipcRenderer.invoke(CHANNEL.authCancel) as Promise<void>,
    onState(listener) {
      if (typeof listener !== "function") throw new TypeError("onState expects a function");
      const forward = (_event: IpcRendererEvent, raw: unknown): void => {
        const state = toSigninState(raw);
        if (state) deliver(listener, state);
      };
      ipcRenderer.on(CHANNEL.authState, forward);
      if (lastState) deliver(listener, lastState);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(CHANNEL.authState, forward);
      };
    },
  };
}
