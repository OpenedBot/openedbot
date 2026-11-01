/**
 * One-release fallback for the OHB_* -> OPENEDBOT_* rename of the desktop
 * dev/test overrides. Imported FIRST by main.ts: an old name still set is
 * copied to its new name (when unset) with one warning; the new name wins.
 * Delete in the release after the rename.
 */
export const DESKTOP_ENV_RENAMES: Readonly<Record<string, string>> = {
  OHB_CONSOLE_URL: "OPENEDBOT_CONSOLE_URL",
  OHB_API_ORIGIN: "OPENEDBOT_API_ORIGIN",
  OHB_SIGNIN_TEMPLATE: "OPENEDBOT_SIGNIN_TEMPLATE",
  OHB_TARGET: "OPENEDBOT_TARGET",
  OHB_POPUP_APP: "OPENEDBOT_POPUP_APP",
  OHB_REMOTE_DEBUGGING_PORT: "OPENEDBOT_REMOTE_DEBUGGING_PORT",
  OHB_DEV_ACCOUNTS_API: "OPENEDBOT_DEV_ACCOUNTS_API",
};

/** No longer read: the OAuth client id comes from config.json (`clientId`) only. */
export const DESKTOP_ENV_DROPPED: readonly string[] = ["OHB_CLIENT_ID"];

export function applyDesktopEnvAliases(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  for (const name of DESKTOP_ENV_DROPPED) {
    if (env[name] !== undefined) warn(`${name} is retired and ignored: remove it from the environment.`);
  }
  for (const [old, next] of Object.entries(DESKTOP_ENV_RENAMES)) {
    const value = env[old];
    if (value === undefined) continue;
    if (env[next] === undefined) {
      env[next] = value;
      warn(`${old} is deprecated: rename it to ${next} (old name read for one more release).`);
    } else if (env[next] !== value) {
      warn(`${old} and ${next} are both set with different values: ${next} wins; remove ${old}.`);
    }
  }
}
