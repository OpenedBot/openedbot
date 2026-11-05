import type { IpcChannel } from "../shared/bridge";

// The IPC channels the preload uses. A sandboxed preload can only
// \`require("electron")\` at run time, but electron-vite bundles this file and
// its relative imports into one script (dist/preload/preload.js), so the
// preload's own modules share it. \`satisfies\` pins the names to the shared
// union; shared/bridge.ts stays type-only for the preload.
export const CHANNEL = {
  readAccessToken: "openedbot:read-access-token",
  refresh: "openedbot:refresh",
  openExternal: "openedbot:open-external",
  signOut: "openedbot:sign-out",
  theme: "openedbot:theme",
  textZoom: "openedbot:text-zoom",
  textZoomInitial: "openedbot:text-zoom-initial",
  authStart: "auth:start",
  authPassword: "auth:password",
  authEmailCode: "auth:email-code",
  authEmailVerify: "auth:email-verify",
  authCancel: "auth:cancel",
  authContext: "auth:context",
  authOpenLegal: "auth:open-legal",
  authState: "auth:state",
} as const satisfies Record<string, IpcChannel>;
