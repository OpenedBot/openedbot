import { expect, test } from "bun:test";
import { applyDesktopEnvAliases } from "../src/main/env-aliases";

test("desktop: an old OHB_* override still works for one release, the new name wins", () => {
  const env: Record<string, string | undefined> = { OHB_TARGET: "preprod", OHB_CONSOLE_URL: "http://old", OPENEDBOT_CONSOLE_URL: "http://new" };
  const warnings: string[] = [];
  applyDesktopEnvAliases(env, (message) => warnings.push(message));
  expect(env.OPENEDBOT_TARGET).toBe("preprod");
  expect(env.OPENEDBOT_CONSOLE_URL).toBe("http://new");
  expect(warnings).toHaveLength(2);
});

test("desktop: OHB_CLIENT_ID is retired, warned once and never read", () => {
  const env: Record<string, string | undefined> = { OHB_CLIENT_ID: "anything" }; // rename:keep
  const warnings: string[] = [];
  applyDesktopEnvAliases(env, (message) => warnings.push(message));
  expect(warnings).toEqual(["OHB_CLIENT_ID is retired and ignored: remove it from the environment."]); // rename:keep
  expect(Object.keys(env).filter((name) => name.startsWith("OPENEDBOT_"))).toEqual([]);
});
