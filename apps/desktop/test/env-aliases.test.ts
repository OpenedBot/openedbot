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
