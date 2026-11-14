import { describe, expect, test } from "bun:test";
import { router } from "../../src/route-tree";
import { proConsole } from "../../src/pro-console/registry";

/**
 * The route snapshot of each pass of `make test-dual`: solo
 * (`OPENEDBOT_CONSOLE_PLUGINS` empty) registers none of the pro routes, pro registers
 * all of them. A solo console therefore has no URL whose screen would call a
 * pro endpoint (and read its 404).
 */
const PRO_ROUTES = ["/settings/billing"];

const pro = Boolean(process.env.OPENEDBOT_CONSOLE_PLUGINS?.trim());
const paths = Object.values(router.routesById as Record<string, { fullPath: string }>).map((route) => route.fullPath);

describe(`route tree (${pro ? "pro" : "solo"})`, () => {
  test("the build carries exactly the expected pro features", () => {
    expect(Object.keys(proConsole()).sort()).toEqual(pro ? ["billing", "permissions"] : []);
  });

  test(pro ? "registers every pro route" : "registers no pro route", () => {
    expect(paths.filter((path) => PRO_ROUTES.includes(path)).sort()).toEqual(pro ? PRO_ROUTES : []);
  });

  test("keeps the core routes in both modes (39)", () => {
    expect(paths.length).toBe(39 + (pro ? PRO_ROUTES.length : 0));
    for (const route of ["/invite/member/$token", "/inbox", "/settings/inbox", "/settings/decisions", "/settings/policies", "/settings/security", "/settings/connectors", "/settings/notch"]) {
      expect(paths).toContain(route);
    }
    // The public landing left the console for its own site.
    expect(paths).not.toContain("/landing");
  });
});
