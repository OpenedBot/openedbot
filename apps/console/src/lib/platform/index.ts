/**
 * The platform's front door for the rest of the console: the desktop
 * app's bridge and what depends on the origin (`platform.ts`). Outside this
 * folder, one imports `lib/platform`, never `lib/platform/native-bridge`
 * (rule `console-plateforme-par-la-facade` of `.dependency-cruiser.cjs`).
 */
export {
  isNativeShell,
  nativeAuth,
  nativeAuthStore,
  nativeBridge,
  NATIVE_SESSION_MARK,
  type NativeAuthBridge,
  type NativeSigninState,
  type OpenedbotNativeBridge,
} from "./native-bridge";
export {
  appUrl,
  CLIENT_HEADER,
  clientHeaders,
  desktopClientId,
  nativeRequestInit,
  openInBrowser,
  publicConsoleOrigin,
  publicConsoleUrl,
  withClientHeaders,
} from "./platform";
