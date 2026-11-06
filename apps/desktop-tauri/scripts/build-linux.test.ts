import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostArch, isLinuxVersion, onlyFile } from "./build-linux";
import { bumpPatch } from "./linux-docker";

describe("Linux build", () => {
  test("versions: X.Y.Z or a tagged test build, nothing else", () => {
    for (const version of ["1.1.0", "1.1.1-test", "0.0.0-ci", "1.2.3-rc.1"]) expect(isLinuxVersion(version)).toBe(true);
    for (const version of ["1.1", "v1.1.0", "1.1.0-", "1.1.0 ", "1.1.0-te st", "1.1.0;rm"]) expect(isLinuxVersion(version)).toBe(false);
  });

  test("the forged manifest announces a later version than the real update", () => {
    expect(bumpPatch("1.1.1-test")).toBe("1.1.2-test");
    expect(bumpPatch("1.1.0")).toBe("1.1.1");
    expect(() => bumpPatch("latest")).toThrow();
  });

  test("Node architectures map to the bundles' names", () => {
    expect(hostArch("x64")).toBe("x86_64");
    expect(hostArch("arm64")).toBe("aarch64");
    expect(hostArch("ia32")).toBeNull();
  });

  test("an artifact is collected only when the bundle directory has exactly one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openedbot-bundle-"));
    try {
      expect(() => onlyFile(dir, ".deb")).toThrow(/found none/);
      writeFileSync(path.join(dir, "openedbot preview_1.1.0_amd64.deb"), "");
      expect(onlyFile(dir, "_1.1.0_amd64.deb")).toBe(path.join(dir, "openedbot preview_1.1.0_amd64.deb"));
      writeFileSync(path.join(dir, "openedbot preview_1.0.9_amd64.deb"), "");
      expect(() => onlyFile(dir, ".deb")).toThrow(/expected one \*\.deb .*, found .*1\.0\.9.*/);
      expect(() => onlyFile(path.join(dir, "missing"), ".deb")).toThrow(/found none/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
