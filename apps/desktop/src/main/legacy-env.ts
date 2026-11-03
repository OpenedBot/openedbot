/**
 * The retired OHB_* names of the desktop dev/test overrides. They are NO
 * LONGER READ: main.ts refuses to start while one is set (legacy-env-guard.ts)
 * rather than open on a target or a console the developer did not mean.
 * This table only names the new variable in the refusal.
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

/**
 * The refusal for the retired OHB_* names set in `env`, or null when there
 * is none. Names only, never a value. `OHB_CLIENT_ID` and any other old name
 * have no successor (the OAuth client id comes from config.json).
 */
export function desktopLegacyEnvRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const names = Object.keys(env)
    .filter((name) => name.startsWith("OHB_") && env[name] !== undefined)
    .sort();
  if (!names.length) return null;
  return [
    "openedbot desktop refuses to start: the retired OHB_ prefix is no longer read.",
    ...names.map((name) => `  ${name}: ${Object.hasOwn(DESKTOP_ENV_RENAMES, name) ? `rename it to ${DESKTOP_ENV_RENAMES[name]}` : "retired: remove it"}`),
  ].join("\n");
}
