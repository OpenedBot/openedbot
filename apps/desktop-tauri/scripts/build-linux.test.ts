import { describe, expect, test } from "bun:test";
import { bundlerNames, expectedPackage, hostArch, isLinuxVersion } from "./build-linux";
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

  test("the bundle collected is the identity's own, never a stale one of the other", () => {
    expect(bundlerNames("preview", "1.1.0", "x86_64")).toEqual({ deb: "openedbot preview_1.1.0_amd64.deb", appimage: "openedbot preview_1.1.0_amd64.AppImage" });
    expect(bundlerNames("production", "1.1.0", "aarch64")).toEqual({ deb: "openedbot_1.1.0_arm64.deb", appimage: "openedbot_1.1.0_aarch64.AppImage" });
  });

  test("what each deb must say about itself", () => {
    expect(expectedPackage("production")).toEqual({ name: "openedbot", binary: "/usr/bin/openedbot", scheme: "openedbot", replaces: "openedbot-desktop" });
    expect(expectedPackage("preview")).toEqual({ name: "openedbot-preview", binary: "/usr/bin/openedbot-desktop-preview", scheme: "openedbot-preview", replaces: null });
  });
});
