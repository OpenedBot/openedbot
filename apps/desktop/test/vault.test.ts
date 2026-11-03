import { describe, expect, test } from "bun:test";
import { hasRealVault } from "../src/main/vault";

const never = () => {
  throw new Error("backend read outside Linux");
};

describe("hasRealVault", () => {
  test("no encryption means no vault, on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(hasRealVault(platform, false, () => "gnome_libsecret")).toBe(false);
    }
  });

  test("macOS and Windows trust safeStorage without reading a backend", () => {
    expect(hasRealVault("darwin", true, never)).toBe(true);
    expect(hasRealVault("win32", true, never)).toBe(true);
  });

  test("Linux keeps libsecret and KWallet", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      expect(hasRealVault("linux", true, () => backend)).toBe(true);
    }
  });

  test("Linux refuses the hardcoded-key fallback and an unresolved backend", () => {
    expect(hasRealVault("linux", true, () => "basic_text")).toBe(false);
    expect(hasRealVault("linux", true, () => "unknown")).toBe(false);
  });
});
