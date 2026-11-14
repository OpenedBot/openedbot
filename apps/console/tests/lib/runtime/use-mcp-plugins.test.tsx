import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeProfileMcpServerDto } from "@openedbot/contracts-api";
import { useConnectedMcpPlugins } from "../../../src/lib/runtime/use-mcp-plugins";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/** The root serves `github` with its token; the bot's profile says what it says. */
function host(scout: RuntimeProfileMcpServerDto[], options: { facts?: boolean; profiles?: () => Promise<Response> } = {}) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(new URL(url, "http://test").pathname);
    if (url.includes("/api/runtime/profiles")) {
      if (options.profiles) return options.profiles();
      return Response.json({ canDelete: false, profiles: [{ name: "scout", mcpServers: scout, ...(options.facts === false ? {} : { mcpFacts: true }) }] });
    }
    if (url.includes("/api/runtime/integrations/mcp")) {
      return Response.json({
        available: true,
        servers: [{ name: "github", auth: "oauth", platformEnabled: true, unreachable: false, oauthTokenPresent: true }],
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return seen;
}

function wrapperOf(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

openSecondaryReads();

test("le composer colore les services du bot (son profil), pas ceux de la racine", async () => {
  host([
    { name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: true },
    { name: "notion", enabled: true, endpoint: "https://mcp.notion.com/mcp", auth: "oauth", oauthTokenPresent: false },
  ]);
  const { result } = renderHook(() => useConnectedMcpPlugins("owner", "scout"), { wrapper: wrapperOf() });
  await waitFor(() => expect(result.current).toEqual(["linear"]));
});

test("un hôte qui ne décrit pas les serveurs du profil : la lecture de la racine, comme avant", async () => {
  host([{ name: "linear", enabled: true }], { facts: false });
  const { result } = renderHook(() => useConnectedMcpPlugins("owner", "scout"), { wrapper: wrapperOf() });
  await waitFor(() => expect(result.current).toEqual(["github"]));
});

test("sans profil (groupe, bot sans profil), le profil n'est même pas lu", async () => {
  const seen = host([]);
  const { result } = renderHook(() => useConnectedMcpPlugins("owner"), { wrapper: wrapperOf() });
  await waitFor(() => expect(result.current).toEqual(["github"]));
  expect(seen.some((path) => path.includes("/profiles"))).toBe(false);
});

test("tant que le profil du bot n'est pas lu, rien n'est coloré : jamais la racine d'abord", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host([{ name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: true }], {
    profiles: async () => {
      await gate;
      return Response.json({ canDelete: false, profiles: [{ name: "scout", mcpFacts: true, mcpServers: [{ name: "linear", enabled: true, auth: "oauth", oauthTokenPresent: true }] }] });
    },
  });
  const seen: (readonly string[])[] = [];
  const { result } = renderHook(() => {
    const names = useConnectedMcpPlugins("owner", "scout");
    seen.push(names);
    return names;
  }, { wrapper: wrapperOf() });
  // The root reading arrives while the profile is still pending: not shown.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(result.current).toEqual([]);
  release();
  await waitFor(() => expect(result.current).toEqual(["linear"]));
  expect(seen.some((names) => names.includes("github"))).toBe(false);
});

test("un profil décrit sans serveur : rien de coloré, pas la racine", async () => {
  host([]);
  const { result } = renderHook(() => useConnectedMcpPlugins("owner", "scout"), { wrapper: wrapperOf() });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(result.current).toEqual([]);
});

test("une lecture des profils en échec n'est pas rejouée à chaque conversation ouverte", async () => {
  let reads = 0;
  host([], { profiles: async () => { reads += 1; return Response.json({ error: { code: "RUNTIME_ADMIN_UNAVAILABLE", message: "x" } }, { status: 502 }); } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = renderHook(() => useConnectedMcpPlugins("owner", "scout"), { wrapper: wrapperOf(client) });
  // Failed: the runtime-wide reading, as before.
  await waitFor(() => expect(first.result.current).toEqual(["github"]));
  first.unmount();
  const second = renderHook(() => useConnectedMcpPlugins("owner", "scout"), { wrapper: wrapperOf(client) });
  await waitFor(() => expect(second.result.current).toEqual(["github"]));
  expect(reads).toBe(1);
});
