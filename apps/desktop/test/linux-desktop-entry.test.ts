import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { desktopName?: string };
const builder = readFileSync(path.join(root, "electron-builder.yml"), "utf8");

describe("Linux: the running window is tied to its launcher", () => {
  test("desktopName names the .desktop entry Electron reports as app_id", () => {
    expect(pkg.desktopName).toBe("openedbot.desktop");
    expect(builder).toMatch(/^\s+syncDesktopName: true$/m);
  });

  test("the icon set holds every hicolor size, each named by its size", () => {
    expect(builder).toMatch(/^\s+icon: build\/icons$/m);
    for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
      expect(existsSync(path.join(root, "build", "icons", `${size}x${size}.png`))).toBe(true);
    }
  });
});
