import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  matchRelayRoute,
  RELAY_ALLOWLIST,
  RELAY_FORWARDED_REQUEST_HEADERS,
  RELAY_FORWARDED_RESPONSE_HEADERS,
} from "../src/index";

// Mêmes cas que `TestAllowlist` dans internal/connector/frames_test.go.
const allowed: Array<[string, "events" | "host" | ""]> = [
  ["GET /health", ""],
  ["GET /v1/capabilities", ""],
  ["GET /v1/toolsets", ""],
  ["GET /api/model/options", ""],
  ["POST /v1/runs", ""],
  ["GET /v1/runs/run_abc", ""],
  ["GET /v1/runs/run_abc/events?since=12", "events"],
  ["POST /v1/runs/run_abc/stop", ""],
  ["POST /v1/runs/run_abc/approval", ""],
  ["GET /p/prod-1/health", ""],
  ["POST /p/prod-1/v1/runs", ""],
  ["GET /api/sessions/s1", ""],
  ["GET /api/sessions/s1/messages", ""],
  ["POST /api/sessions", ""],
  ["DELETE /api/sessions/s1", ""],
  ["DELETE /p/prod-1/api/sessions/s1", ""],
  // Les VRAIS noms de session d'openedbot : `openedbot:<org>:<...>`, dont
  // `encodeURIComponent` écrit chaque deux-points `%3A`. Les tests d'origine
  // ne connaissaient que `s1`, un nom qu'openedbot ne produit jamais, et la liste
  // refusait donc, en production, les trois routes de session.
  ["DELETE /api/sessions/openedbot%3A00000000-0000-4000-8000-000000000201%3A57cc181a-554c-41e4-bdd1-b6d360290ddb", ""],
  ["GET /api/sessions/openedbot%3Aorg-1%3Acompact%3Athread%3At-1", ""],
  ["GET /api/sessions/openedbot%3Aorg-1%3Amemory%3Abot%3Ab-1/messages", ""],
  ["DELETE /p/prod-1/api/sessions/openedbot%3aorg-1%3aworkflow%3aw-1%3abot%3ab-1", ""],
  ["GET /api/mcp/servers", ""],
  // Routes hôte : la sonde de capacités et les quatre verbes fournisseur,
  // servis par le connecteur.
  ["GET /hermes-setup/capabilities", "host"],
  ["GET /p/prod-1/hermes-setup/capabilities", "host"],
  ["GET /hermes-setup/usage", "host"],
  ["GET /hermes-setup/model-context", "host"],
  ["POST /hermes-setup/providers/openai-codex/credentials", "host"],
  ["POST /hermes-setup/providers/anthropic/oauth", "host"],
  ["GET /hermes-setup/providers/openai-codex/oauth/abc123", "host"],
  ["DELETE /hermes-setup/providers/anthropic/oauth/s-1", "host"],
  ["POST /p/prod-1/hermes-setup/providers/anthropic/oauth", "host"],
  // Verbes toolset et MCP : la surface qui rend la page Connecteurs pilotable
  // depuis openedbot au lieu d'une console sur l'hôte.
  ["GET /hermes-setup/toolsets", "host"],
  ["POST /hermes-setup/toolsets/browser", "host"],
  ["POST /hermes-setup/toolsets/code_execution", "host"],
  ["GET /hermes-setup/mcp/servers", "host"],
  ["POST /hermes-setup/mcp/servers", "host"],
  ["DELETE /hermes-setup/mcp/servers/linear", "host"],
  ["POST /hermes-setup/mcp/catalog/n8n", "host"],
  ["POST /p/prod-1/hermes-setup/toolsets/web", "host"],
  // OAuth MCP : la jambe navigateur d'un serveur `auth: oauth`, et le seul
  // redémarrage que le lien porte, celui du gateway.
  ["POST /hermes-setup/mcp/servers/notion/oauth", "host"],
  ["GET /hermes-setup/mcp/servers/notion/oauth/abc123", "host"],
  ["POST /hermes-setup/mcp/servers/notion/oauth/callback", "host"],
  ["DELETE /hermes-setup/mcp/servers/notion/oauth/abc123", "host"],
  ["GET /hermes-setup/gateway", "host"],
  ["POST /hermes-setup/gateway/restart", "host"],
  ["GET /hermes-setup/gateway/restart/job1", "host"],
  ["POST /p/prod-1/hermes-setup/gateway/restart", "host"],
  ["GET /hermes-setup/profiles", "host"],
  ["POST /hermes-setup/profiles", "host"],
  ["DELETE /hermes-setup/profiles/scout", "host"],
  ["POST /hermes-setup/profiles/scout/toolsets/web", "host"],
  ["GET /hermes-setup/profiles/scout/memory", "host"],
  ["POST /hermes-setup/profiles/scout/memory", "host"],
  ["POST /hermes-setup/profiles/scout/model", "host"],
  ["POST /p/prod-1/hermes-setup/profiles/scout/model", "host"],
  ["POST /hermes-setup/profiles/scout/mcp/servers/linear", "host"],
  ["POST /hermes-setup/profiles/scout/skills/hermes-agent", "host"],
  ["POST /hermes-setup/profiles/scout/skills/research", "host"],
  ["POST /hermes-setup/profiles/scout/bundled-skills", "host"],
  // Hub de skills (MARKETPLACE_ADR section 6) : l'identifiant
  // voyage dans le corps, le chemin ne porte que le profil et un UUID.
  ["POST /hermes-setup/skills/hub/search", "host"],
  ["POST /hermes-setup/skills/hub/inspect", "host"],
  ["POST /hermes-setup/profiles/scout/skills/hub/scan", "host"],
  ["POST /hermes-setup/profiles/scout/skills/hub/install", "host"],
  ["GET /hermes-setup/profiles/scout/skills/hub/operations/9f0c2a4e-8b1d-4c3e-9a7f-2d6b5e1c0a3f", "host"],
  ["DELETE /hermes-setup/profiles/scout/skills/research", "host"],
  ["POST /hermes-setup/profiles/seo-geo/providers/anthropic/credentials", "host"],
  ["DELETE /hermes-setup/profiles/scout/providers/openai/credentials", "host"],
  ["GET /hermes-setup/profiles/scout/avatar", "host"],
  ["GET /p/prod-1/hermes-setup/profiles", "host"],
  ["GET /p/prod-1/hermes-setup/profiles/seo-geo/avatar", "host"],
  // Inventaire borné des sessions : la lecture que le worker recoupe avec
  // ses propres dispatches pour repérer une création hors du lien.
  ["GET /hermes-setup/sessions-inventory", "host"],
  ["GET /p/prod-1/hermes-setup/sessions-inventory", "host"],
  // Lecture de carte A2A nommée, jamais un relais JSON-RPC ou un chemin fourni.
  ["GET /hermes-setup/a2a/agent-card", "host"],
  ["GET /p/prod-1/hermes-setup/a2a/agent-card", "host"],
  ["GET /hermes-setup/a2a/audit", "host"],
  ["GET /hermes-setup/a2a/audit?limit=1", "host"],
  ["GET /hermes-setup/a2a/audit?limit=37", "host"],
  ["GET /hermes-setup/a2a/audit?limit=100", "host"],
];

const refused = [
  "DELETE /v1/runs/x",
  "DELETE /api/sessions",
  "DELETE /api/sessions/s1/messages",
  // `%3A` est le seul échappement admis : un `/` ou un `.` déguisé en
  // pourcentage redeviendrait un chemin une fois décodé par le gateway.
  "DELETE /api/sessions/openedbot%2Fetc%2Fpasswd",
  "DELETE /api/sessions/%2e%2e%2fadmin",
  "DELETE /api/sessions/openedbot%3Aorg%25",
  `DELETE /api/sessions/${"a".repeat(257)}`,
  "POST /api/mcp/servers",
  "GET /v1/browser-control/x",
  "POST /api/credentials/pool",
  "GET /auth/password-login",
  "GET /v1/runs/../../etc",
  "GET /v1/runs//x",
  "GET /p/BAD/health",
  "PUT /v1/runs/x",
  "GET /p/prod-1",
  "GET /health/extra",
  "GET v1/health",
  // Hors de la sonde et des quatre verbes fournisseur : rien d'autre n'atteint l'hôte.
  "POST /hermes-setup/capabilities",
  "POST /hermes-setup/sessions-inventory",
  "GET /hermes-setup/sessions-inventory/s1",
  "POST /hermes-setup/a2a/agent-card",
  "GET /hermes-setup/a2a/agent-card/extra",
  "POST /hermes-setup/a2a/audit",
  "GET /hermes-setup/a2a/audit/extra",
  "GET /p/prod-1/hermes-setup/a2a/audit",
  "GET /hermes-setup/a2a/audit?",
  "GET /hermes-setup/a2a/audit?limit=0",
  "GET /hermes-setup/a2a/audit?limit=01",
  "GET /hermes-setup/a2a/audit?limit=101",
  "GET /hermes-setup/a2a/audit?limit=1&limit=2",
  "GET /hermes-setup/a2a/audit?limit=1&extra=x",
  "POST /hermes-setup/a2a/message/send",
  "GET /hermes-setup/a2a/agent-card/../message/send",
  "GET /hermes-setup/capabilities/extra",
  "GET /hermes-setup/providers/x/credentials",
  "POST /hermes-setup/exec",
  "POST /hermes-setup/providers/Bad_Slug/credentials",
  "PUT /hermes-setup/providers/x/oauth",
  "DELETE /hermes-setup/providers/x/credentials",
  "GET /hermes-setup/providers/x/oauth",
  // Un toolset ne s'écrit pas en masse, et son nom n'admet ni tiret ni
  // majuscule : la seule écriture est un toolset nommé.
  "POST /hermes-setup/toolsets",
  "DELETE /hermes-setup/toolsets/web",
  "POST /hermes-setup/toolsets/Web",
  "POST /hermes-setup/toolsets/web-search",
  "GET /hermes-setup/toolsets/web",
  // Le catalogue s'installe, il ne se liste pas par cette route, et un
  // serveur MCP ne se modifie pas en place.
  "GET /hermes-setup/mcp/catalog",
  "PUT /hermes-setup/mcp/servers/linear",
  "POST /hermes-setup/mcp/servers/linear",
  "DELETE /hermes-setup/mcp/catalog/n8n",
  "DELETE /hermes-setup/mcp/servers",
  "GET /hermes-setup/mcp",
  // L'OAuth nomme un serveur et une session ; le callback ne nomme que le
  // serveur. Le redémarrage ne nomme rien : ni unité, ni verbe, ni argument.
  "GET /hermes-setup/mcp/servers/notion/oauth",
  "PUT /hermes-setup/mcp/servers/notion/oauth",
  "POST /hermes-setup/mcp/servers/notion/oauth/abc123",
  "POST /hermes-setup/mcp/servers/bad%20name/oauth",
  "POST /hermes-setup/mcp/oauth",
  "POST /hermes-setup/gateway",
  "DELETE /hermes-setup/gateway",
  "POST /hermes-setup/gateway/stop",
  "POST /hermes-setup/gateway/restart/job1",
  "POST /hermes-setup/gateway/restart/hermes-connector",
  "GET /hermes-setup/gateway/restart",
  "POST /hermes-setup/restart",
  "POST /hermes-setup/connector/restart",
  "GET /hermes-setup/profiles/scout",
  "GET /hermes-setup/profiles/scout/model",
  "PUT /hermes-setup/profiles/scout/model",
  "POST /hermes-setup/profiles/Scout/model",
  "POST /hermes-setup/profiles/scout/models",
  "DELETE /hermes-setup/profiles/scout/model",
  "POST /hermes-setup/profiles/Scout/toolsets/web",
  "POST /hermes-setup/profiles/scout/toolsets/web-search",
  "POST /hermes-setup/profiles/scout/mcp/servers/bad%20name",
  "POST /hermes-setup/profiles/scout/skills/Web",
  "POST /hermes-setup/profiles/scout/skills/bad name",
  "GET /hermes-setup/profiles/scout/skills/research",
  "DELETE /hermes-setup/profiles/scout/skills/bad name",
  "GET /hermes-setup/profiles/scout/skills/hub/operations/not-a-uuid",
  "POST /hermes-setup/profiles/scout/skills/hub/operations/9f0c2a4e-8b1d-4c3e-9a7f-2d6b5e1c0a3f",
  "POST /hermes-setup/skills/hub/install",
  "POST /hermes-setup/profiles/scout/providers/Bad/credentials",
  "GET /hermes-setup/profiles/scout/providers/anthropic/credentials",
  "PUT /hermes-setup/profiles/scout/providers/anthropic/credentials",
  "GET /hermes-setup/profiles/scout/soul",
  "DELETE /hermes-setup/profiles/scout/memory",
  "GET /hermes-setup/profiles/Scout/memory",
  "GET /hermes-setup/profiles/scout/memory/MEMORY.md",
  "GET /hermes-setup/profiles/Default/avatar",
  "GET /hermes-setup/profiles/scout/avatar/extra",
  "GET /hermes-setup/profile",
];

function split(entry: string): [string, string] {
  const space = entry.indexOf(" ");
  return [entry.slice(0, space), entry.slice(space + 1)];
}

describe("relay allowlist: identical to internal/connector/allowlist.go", () => {
  test("is frozen at 15 gateway routes plus 54 host routes", () => {
    expect(RELAY_ALLOWLIST.length).toBe(69);
    expect(Object.isFrozen(RELAY_ALLOWLIST)).toBe(true);
    expect(RELAY_ALLOWLIST.filter((route) => route.events).length).toBe(1);
    expect(RELAY_ALLOWLIST.filter((route) => route.host).length).toBe(54);
    expect(RELAY_ALLOWLIST.filter((route) => !route.host).length).toBe(15);
  });

  // Le manifeste que `TestAllowlistManifest` écrit depuis allowlist.go ; `make
  // contract-check` à la racine vérifie que cette copie est identique à
  // test/golden/relay-allowlist/allowlist.json de edge-setup.
  test("matches the allowlist manifest shared with allowlist.go", () => {
    type ManifestRoute = { method: string; path: string; events: boolean; host: boolean };
    const manifest = JSON.parse(
      readFileSync(new URL("../fixtures/relay-allowlist.json", import.meta.url), "utf8"),
    ) as ManifestRoute[];
    const key = (route: { method: string; source: string; events: boolean; host: boolean }) =>
      `${route.method} ${route.source} events=${route.events} host=${route.host}`;
    expect(RELAY_ALLOWLIST.map((route) => key({ ...route, source: route.path.source })).sort()).toEqual(
      manifest.map((route) => key({ ...route, source: new RegExp(route.path).source })).sort(),
    );
  });

  for (const [entry, kind] of allowed) {
    test(`allows ${entry}`, () => {
      const [method, path] = split(entry);
      const route = matchRelayRoute(method, path);
      expect(route).not.toBeNull();
      expect(route!.events).toBe(kind === "events");
      expect(route!.host).toBe(kind === "host");
    });
  }

  for (const entry of refused) {
    test(`refuses ${entry}`, () => {
      const [method, path] = split(entry);
      expect(matchRelayRoute(method, path)).toBeNull();
    });
  }

  test("uppercases methods, keeps generic query behavior, and validates A2A audit query", () => {
    expect(matchRelayRoute("get", "/health?x=1")).not.toBeNull();
    expect(matchRelayRoute("post", "/v1/runs/run_1/steer")).not.toBeNull();
    expect(matchRelayRoute("get", "/hermes-setup/a2a/audit?limit=50")).not.toBeNull();
    expect(matchRelayRoute("get", "/hermes-setup/a2a/audit?limit=50&limit=20")).toBeNull();
  });

  test("keeps named A2A peer writes at the root with no query or generic operation", () => {
    const endpoints: Array<[string, string]> = [
      ["GET", "/hermes-setup/a2a/peers"],
      ["POST", "/hermes-setup/a2a/peers/alpha.bot/trust"],
      ["POST", "/hermes-setup/a2a/peers/alpha.bot/token"],
      ["DELETE", "/hermes-setup/a2a/peers/alpha.bot/token"],
    ];
    for (const [method, path] of endpoints) {
      expect(matchRelayRoute(method, path)?.host).toBe(true);
      expect(matchRelayRoute(method, `${path}?`)).toBeNull();
      expect(matchRelayRoute(method, `${path}?runtimeId=other`)).toBeNull();
      expect(matchRelayRoute(method, `/p/demo${path}`)).toBeNull();
    }
    for (const path of [
      "/hermes-setup/a2a/peers/Alpha/trust", "/hermes-setup/a2a/peers/a..b/trust",
      "/hermes-setup/a2a/peers/a%2Fb/trust", "/hermes-setup/a2a/peers/a/exec",
      "/hermes-setup/a2a/peers/a/restart", "/hermes-setup/a2a/message/send",
    ]) expect(matchRelayRoute("POST", path)).toBeNull();
  });

  test("reads one bounded workspace file name at the root, never a path", () => {
    for (const path of ["/hermes-setup/workspace/files/chart.png", "/hermes-setup/workspace/files/rapport_2026-11.pdf"]) {
      expect(matchRelayRoute("GET", path)?.host).toBe(true);
      expect(matchRelayRoute("GET", `${path}?`)).toBeNull();
      expect(matchRelayRoute("GET", `${path}?path=/etc/passwd`)).toBeNull();
      expect(matchRelayRoute("GET", `/p/demo${path}`)).toBeNull();
      expect(matchRelayRoute("POST", path)).toBeNull();
    }
    for (const path of [
      "/hermes-setup/workspace/files/sub/chart.png", "/hermes-setup/workspace/files/../runtime.env",
      "/hermes-setup/workspace/files/.env.png", "/hermes-setup/workspace/files/a%2Fb.png",
      "/hermes-setup/workspace/files/notes.txt", "/hermes-setup/workspace/files/",
    ]) expect(matchRelayRoute("GET", path)).toBeNull();
  });

  test("never lists an administration verb, except the one gateway restart", () => {
    // Le SEUL redémarrage du lien : `POST /hermes-setup/gateway/restart` et sa
    // lecture. Route fixe, unité fixe sur l'hôte, aucun argument. Tout autre
    // `restart`, et tout `exec`/`update`/`config`/`shell`, reste interdit.
    const GATEWAY_RESTART = /^\^\\\/hermes-setup\\\/gateway\\\/restart(\$|\\\/)/;
    for (const route of RELAY_ALLOWLIST) {
      if (GATEWAY_RESTART.test(route.path.source)) {
        expect(route.host).toBe(true);
        expect(route.path.source).not.toMatch(/exec|update|config|shell/i);
        continue;
      }
      expect(route.path.source).not.toMatch(/exec|update|restart|config|shell/i);
      expect(["GET", "POST", "PUT", "DELETE"]).toContain(route.method);
    }
    expect(RELAY_ALLOWLIST.filter((route) => /restart/i.test(route.path.source)).map((route) => `${route.method} ${route.path.source.replaceAll("\\/", "/")}`).sort()).toEqual([
      "GET ^/hermes-setup/gateway/restart/[A-Za-z0-9._~-]{1,128}$",
      "POST ^/hermes-setup/gateway/restart$",
    ]);
    for (const route of RELAY_ALLOWLIST.filter((entry) => !entry.host)) {
      expect(route.path.source).not.toMatch(/credential|hermes-setup/i);
      expect(["GET", "POST", "DELETE"]).toContain(route.method);
      // La seule destruction que le lien porte côté gateway est celle d'une
      // session : un DELETE ailleurs serait un verbe d'administration.
      if (route.method === "DELETE") {
        expect(route.path.test("/api/sessions/s1")).toBe(true);
        expect(route.path.test("/v1/runs/r1")).toBe(false);
      }
    }
    // Toute route hôte vit sous `/hermes-setup/`, et son chemin est FERMÉ :
    // chaque segment variable est une classe bornée (slug fournisseur, clé de
    // toolset, nom de serveur MCP), jamais un `.` ni un `+` qui laisserait
    // passer un chemin de fichier ou une commande.
    // `RegExp.source` échappe les barres obliques : on compare la forme lue.
    const pattern = (route: (typeof RELAY_ALLOWLIST)[number]) => route.path.source.replaceAll("\\/", "/");
    for (const route of RELAY_ALLOWLIST.filter((entry) => entry.host)) {
      expect(pattern(route).startsWith("^/hermes-setup/")).toBe(true);
      expect(route.path.test("/v1/runs")).toBe(false);
      expect(pattern(route)).not.toMatch(/\.\*|\.\+|\\S|\\w\+/);
    }
    // Le jeu exact des écritures hôte. Une ligne de plus ici est une décision,
    // jamais un effet de bord : c'est le seul endroit du dépôt où le lien
    // gagne un pouvoir sur la machine du client.
    expect(
      RELAY_ALLOWLIST.filter((entry) => entry.host && entry.method !== "GET").map(pattern).sort(),
    ).toEqual([
      "^/hermes-setup/a2a/peers/[a-z0-9][a-z0-9._-]{0,63}/token$",
      "^/hermes-setup/a2a/peers/[a-z0-9][a-z0-9._-]{0,63}/token$",
      "^/hermes-setup/a2a/peers/[a-z0-9][a-z0-9._-]{0,63}/trust$",
      "^/hermes-setup/gateway/restart$",
      "^/hermes-setup/mcp/catalog/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      "^/hermes-setup/mcp/servers$",
      "^/hermes-setup/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      "^/hermes-setup/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/oauth$",
      "^/hermes-setup/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/oauth/[A-Za-z0-9._~-]{1,128}$",
      "^/hermes-setup/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/oauth/callback$",
      "^/hermes-setup/profiles$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/approval-policy$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/bundled-skills$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/mcp/servers/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/memory$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/model$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/providers/[a-z0-9][a-z0-9_-]{0,63}/credentials$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/providers/[a-z0-9][a-z0-9_-]{0,63}/credentials$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/skills/[a-z0-9][a-z0-9_-]{0,63}$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/skills/[a-z0-9][a-z0-9_-]{0,63}$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/skills/hub/install$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/skills/hub/scan$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/toolsets$",
      "^/hermes-setup/profiles/[a-z0-9][a-z0-9_-]{0,62}/toolsets/[a-z0-9][a-z0-9_]{0,63}$",
      "^/hermes-setup/profiles/models$",
      "^/hermes-setup/providers/[a-z0-9][a-z0-9_-]{0,63}/credentials$",
      "^/hermes-setup/providers/[a-z0-9][a-z0-9_-]{0,63}/oauth$",
      "^/hermes-setup/providers/[a-z0-9][a-z0-9_-]{0,63}/oauth/[A-Za-z0-9._~-]{1,128}$",
      "^/hermes-setup/skills/hub/inspect$",
      "^/hermes-setup/skills/hub/search$",
      "^/hermes-setup/toolsets/[a-z0-9][a-z0-9_]{0,63}$",
    ]);
  });

  test("forwards exactly the contract headers", () => {
    expect([...RELAY_FORWARDED_REQUEST_HEADERS].sort()).toEqual([
      "accept",
      "cache-control",
      "content-type",
      "idempotency-key",
      "last-event-id",
      "traceparent",
    ]);
    expect([...RELAY_FORWARDED_RESPONSE_HEADERS].sort()).toEqual(["content-type", "retry-after"]);
  });
});
