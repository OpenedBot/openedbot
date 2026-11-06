import { describe, expect, test } from "bun:test";
import { compareSemVer, DEFAULT_NATIVE_APP_ORIGINS, parseSemVer, readNativeClients } from "../src/native-clients";
import { readApiConfig } from "../src/api-config";

describe("clients natifs", () => {
  test("par défaut : les origines de Tauri, aucune version minimale", () => {
    expect(readNativeClients({}, [])).toEqual({ origins: [...DEFAULT_NATIVE_APP_ORIGINS], minDesktopVersion: null });
    expect(readNativeClients({ NATIVE_APP_ORIGINS: "  " }, []).origins).toEqual([...DEFAULT_NATIVE_APP_ORIGINS]);
  });

  test("une liste explicite remplace le défaut, sans doublon", () => {
    expect(readNativeClients({ NATIVE_APP_ORIGINS: "tauri://localhost, tauri://localhost,http://tauri.localhost:8080" }, []).origins)
      .toEqual(["tauri://localhost", "http://tauri.localhost:8080"]);
  });

  test("refuse null, *, un chemin, une majuscule ou une origine web déjà listée", () => {
    for (const bad of ["null", "*", "tauri://localhost/", "tauri://localhost/app", "Tauri://localhost", "localhost"]) {
      expect(() => readNativeClients({ NATIVE_APP_ORIGINS: bad }, [])).toThrow(/NATIVE_APP_ORIGINS/);
    }
    expect(() => readNativeClients({ NATIVE_APP_ORIGINS: "https://openedbot.app" }, ["https://openedbot.app"])).toThrow(/already a web origin/);
  });

  test("DESKTOP_MIN_VERSION est X.Y.Z", () => {
    expect(readNativeClients({ DESKTOP_MIN_VERSION: "1.4.0" }, []).minDesktopVersion).toEqual([1, 4, 0]);
    for (const bad of ["1.4", "v1.4.0", "1.4.0-beta", "latest"]) {
      expect(() => readNativeClients({ DESKTOP_MIN_VERSION: bad }, [])).toThrow(/DESKTOP_MIN_VERSION/);
    }
  });

  test("comparaison numérique, pas lexicale", () => {
    expect(compareSemVer(parseSemVer("1.10.0")!, parseSemVer("1.9.9")!)).toBeGreaterThan(0);
    expect(compareSemVer(parseSemVer("1.2.3")!, parseSemVer("1.2.3")!)).toBe(0);
    expect(compareSemVer(parseSemVer("0.9.0")!, parseSemVer("1.0.0")!)).toBeLessThan(0);
  });

  test("la config de l'API les porte, à part des origines web", () => {
    const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
    expect(config.nativeClients.origins).toEqual([...DEFAULT_NATIVE_APP_ORIGINS]);
    expect(config.browserOrigins).not.toContain("tauri://localhost");
    expect(config.webOrigins).not.toContain("tauri://localhost");
  });
});
