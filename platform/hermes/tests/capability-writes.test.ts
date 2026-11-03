import { describe, expect, test } from "bun:test";
import { hermesCapabilityWrite } from "../src/capability-writes";

describe("hermesCapabilityWrite", () => {
  test("les bascules d'un profil marquent ce profil", () => {
    const cases: Array<[string, string]> = [
      ["POST", "/hermes-setup/profiles/recherche/toolsets/web"],
      // Le lot (profile_toolsets_batch) : le socle d'un bot neuf.
      ["POST", "/hermes-setup/profiles/recherche/toolsets"],
      ["POST", "/hermes-setup/profiles/recherche/skills/claude-code"],
      ["DELETE", "/hermes-setup/profiles/recherche/skills/claude-code"],
      ["POST", "/hermes-setup/profiles/recherche/bundled-skills"],
      ["POST", "/hermes-setup/profiles/recherche/skills/hub/install"],
      ["POST", "/hermes-setup/profiles/recherche/mcp/servers/linear"],
      ["DELETE", "/hermes-setup/profiles/recherche/mcp/servers/linear"],
      ["POST", "/hermes-setup/profiles/recherche/providers/xai/credentials"],
      ["DELETE", "/hermes-setup/profiles/recherche/providers/xai/credentials?x=1"],
      // Le client d'un profil préfixe tout par /p/<slug> ; le connecteur l'ignore.
      ["POST", "/p/recherche/hermes-setup/profiles/recherche/toolsets/web"],
    ];
    for (const [method, path] of cases) expect(hermesCapabilityWrite(method, path)).toEqual({ profile: "recherche" });
  });

  test("les écritures de la racine marquent la racine", () => {
    const cases: Array<[string, string]> = [
      ["POST", "/hermes-setup/toolsets/web"],
      ["POST", "/hermes-setup/mcp/servers"],
      ["DELETE", "/hermes-setup/mcp/servers/linear"],
      ["POST", "/hermes-setup/mcp/catalog/github"],
      ["POST", "/hermes-setup/mcp/servers/linear/oauth/callback"],
      ["POST", "/hermes-setup/providers/xai/credentials"],
      ["post", "/hermes-setup/gateway/restart"],
      // Le rappel OAuth ne nomme pas le profil : il compte pour tous.
      ["POST", "/p/recherche/hermes-setup/mcp/servers/linear/oauth/callback"],
    ];
    for (const [method, path] of cases) expect(hermesCapabilityWrite(method, path)).toEqual({ profile: null });
  });

  test("lectures, runs et réglages sans effet sur les outils ne marquent rien", () => {
    const cases: Array<[string, string]> = [
      ["GET", "/hermes-setup/toolsets"],
      ["GET", "/hermes-setup/profiles/recherche/toolsets"],
      ["GET", "/hermes-setup/skills"],
      ["POST", "/v1/runs"],
      ["POST", "/p/recherche/v1/runs"],
      ["POST", "/hermes-setup/profiles/recherche/model"],
      ["POST", "/hermes-setup/profiles/recherche/memory"],
      ["PUT", "/hermes-setup/profiles/recherche/approval-policy"],
      ["POST", "/hermes-setup/profiles"],
      ["DELETE", "/hermes-setup/profiles/recherche"],
      ["POST", "/hermes-setup/profiles/recherche/skills/hub/scan"],
      ["POST", "/hermes-setup/mcp/servers/linear/oauth"],
      ["GET", "/p/recherche/hermes-setup/mcp/servers/linear/oauth/callback"],
      ["POST", "/p/recherche/hermes-setup/skills/hub/search"],
      ["POST", "/hermes-setup/profiles/Bad/toolsets/web"],
    ];
    for (const [method, path] of cases) expect(hermesCapabilityWrite(method, path)).toBeNull();
  });
});
