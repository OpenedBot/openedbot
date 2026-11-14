import { describe, expect, test } from "bun:test";
import { readRuntimeLinkConfig, RUNTIME_LINK_DB_MAX_DEFAULT } from "../src/application/config";

describe("dedicated link gateway configuration", () => {
  test("defaults preserve embedded API deployment and isolated gateway listener", () => {
    expect(readRuntimeLinkConfig({})).toEqual({ mode: "embedded", host: "127.0.0.1", port: 8791, internalUrl: "http://127.0.0.1:8791", drainTimeoutMs: 30_000, dbMax: RUNTIME_LINK_DB_MAX_DEFAULT });
  });
  test("separate mode requires an explicit internal origin", () => {
    expect(() => readRuntimeLinkConfig({ RUNTIME_LINK_MODE: "separate" })).toThrow("RUNTIME_LINK_INTERNAL_URL");
    expect(readRuntimeLinkConfig({ RUNTIME_LINK_MODE: "separate", RUNTIME_LINK_INTERNAL_URL: "https://link.internal/", RUNTIME_LINK_PORT: "9000", RUNTIME_LINK_HOST: "0.0.0.0", RUNTIME_LINK_DRAIN_TIMEOUT_MS: "120000", RUNTIME_LINK_DB_MAX: "24" })).toEqual({ mode: "separate", host: "0.0.0.0", port: 9000, internalUrl: "https://link.internal", drainTimeoutMs: 120_000, dbMax: 24 });
  });
  test("rejects malformed mode, listener bounds and unsafe advertised origins", () => {
    for (const overrides of [
      { RUNTIME_LINK_MODE: "other" },
      { RUNTIME_LINK_PORT: "0" },
      { RUNTIME_LINK_PORT: "65536" },
      { RUNTIME_LINK_DRAIN_TIMEOUT_MS: "-1" },
      { RUNTIME_LINK_DRAIN_TIMEOUT_MS: "300001" },
      { RUNTIME_LINK_INTERNAL_URL: "not-url" },
      { RUNTIME_LINK_INTERNAL_URL: "ftp://link.internal" },
      { RUNTIME_LINK_INTERNAL_URL: "https://user:secret@link.internal" },
      { RUNTIME_LINK_INTERNAL_URL: "https://link.internal/path" },
      { RUNTIME_LINK_INTERNAL_URL: "https://link.internal?x=1" },
      { RUNTIME_LINK_DB_MAX: "0" },
      { RUNTIME_LINK_DB_MAX: "257" },
      { RUNTIME_LINK_DB_MAX: "8.5" },
    ]) expect(() => readRuntimeLinkConfig(overrides)).toThrow();
  });

  /**
   * La passerelle ne doit plus réserver le pool d'une API complète : une
   * connexion suffit en régime établi, et les places gardées pour rien ont
   * déjà fermé un lien connecteur pendant neuf heures.
   */
  test("the gateway pool stays well under an API pool and is tunable", () => {
    expect(RUNTIME_LINK_DB_MAX_DEFAULT).toBeLessThan(32);
    expect(readRuntimeLinkConfig({ RUNTIME_LINK_DB_MAX: "4" }).dbMax).toBe(4);
    expect(readRuntimeLinkConfig({ API_DB_MAX: "64" }).dbMax).toBe(RUNTIME_LINK_DB_MAX_DEFAULT);
  });
});
