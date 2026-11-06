/**
 * La porte d'entrée de la plateforme pour le reste de la console : le pont de
 * l'app de bureau et ce qui dépend de l'origine (`platform.ts`). Hors de ce
 * dossier, on importe `lib/platform`, jamais `lib/platform/native-bridge`
 * (règle `console-plateforme-par-la-facade` de `.dependency-cruiser.cjs`).
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
