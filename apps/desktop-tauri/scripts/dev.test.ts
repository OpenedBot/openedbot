import { describe, expect, test } from "bun:test";
import { devConfig, devPort } from "./dev";

describe("desktop dev launcher", () => {
  test("the dev build has its own identity and loads the desktop Vite", () => {
    const config = devConfig(1422, "/repo/apps/console");
    expect(config).toMatchObject({ identifier: "app.openedbot.desktop.dev", productName: "openedbot dev" });
    expect(config.build.devUrl).toBe("http://localhost:1422");
    expect(config.build.beforeDevCommand.cwd).toBe("/repo/apps/console");
    expect(config.build.beforeDevCommand.script).toContain("VITE_OPENEDBOT_SHELL=tauri");
    expect(config.build.beforeDevCommand.script).toContain("--port 1422 --strictPort");
  });

  test("the port defaults to 1422 and refuses anything but a TCP port", () => {
    expect(devPort(undefined)).toBe(1422);
    expect(devPort("1500")).toBe(1500);
    for (const bad of ["", "abc", "0", "70000", "14.2"]) expect(() => devPort(bad)).toThrow();
  });
});

test("MCP session uses its private identity without changing the default",()=>{
  expect(devConfig(1432,"/repo/apps/console","app.openedbot.desktop.mcp123").identifier).toBe("app.openedbot.desktop.mcp123");
  expect(devConfig(1422,"/repo/apps/console").identifier).toBe("app.openedbot.desktop.dev");
});
