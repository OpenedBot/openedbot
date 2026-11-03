import type { IpcChannel } from "../shared/bridge";

// The IPC channels the preload uses. A sandboxed preload can only
// \`require("electron")\` at run time, but electron-vite bundles this file and
// its relative imports into one script (dist/preload/preload.js), so the
// preload's own modules share it. \`satisfies\` pins the names to the shared
// union; shared/bridge.ts stays type-only for the preload.
export const CHANNEL = {
  readAccessToken: "ohb:read-access-token",
  refresh: "ohb:refresh",
  openExternal: "ohb:open-external",
  signOut: "ohb:sign-out",
  theme: "ohb:theme",
  textZoom: "ohb:text-zoom",
  textZoomInitial: "ohb:text-zoom-initial",
  authStart: "auth:start",
  authPassword: "auth:password",
  authEmailCode: "auth:email-code",
  authEmailVerify: "auth:email-verify",
  authCancel: "auth:cancel",
  authContext: "auth:context",
  authOpenLegal: "auth:open-legal",
  authState: "auth:state",
} as const satisfies Record<string, IpcChannel>;
