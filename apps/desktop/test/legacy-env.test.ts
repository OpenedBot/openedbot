import { expect, test } from "bun:test";
import { desktopLegacyEnvRefusal } from "../src/main/legacy-env";

test("desktop: no retired name, no refusal", () => {
  expect(desktopLegacyEnvRefusal({ OPENEDBOT_TARGET: "preprod", HOME: "/home/x" })).toBeNull();
});

test("desktop: an OHB_* name is refused with its new name, never its value", () => {
  const refusal = desktopLegacyEnvRefusal({ OHB_TARGET: "secret-target", OHB_CLIENT_ID: "client-123", OPENEDBOT_TARGET: "x" });
  expect(refusal).toContain("  OHB_CLIENT_ID: retired: remove it");
  expect(refusal).toContain("  OHB_TARGET: rename it to OPENEDBOT_TARGET");
  expect(refusal).not.toContain("secret-target");
  expect(refusal).not.toContain("client-123");
});
