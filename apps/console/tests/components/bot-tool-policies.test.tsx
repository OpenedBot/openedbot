import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { queryKeys } from "../../src/lib/api";
import { BotToolPolicies } from "../../src/components/bot-manage/bot-tool-policies";

const realFetch = globalThis.fetch;
beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  // Nothing here may reach the network: every read is seeded.
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  globalThis.fetch = realFetch;
});

test("the routine tool's row says that reading its list never asks, whatever its policy", async () => {
  const bot = { id: "bot-1", name: "Atlas" } as BotDto;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.botToolPolicies(bot.id), { botId: bot.id, policies: [{ toolKey: "mcp:openedbot_routines:routine_manage", policy: "ask" }], writable: true, enforced: true });
  client.setQueryData(queryKeys.botCapabilities(bot.id), {
    mcpServers: [
      { name: "linear", enabled: true, transport: "http", tools: ["create_issue"], unreachable: false },
      { name: "openedbot_routines", enabled: true, transport: "http", tools: ["routine_manage"], unreachable: false },
    ],
  });
  client.setQueryData(queryKeys.authMe, null);
  render(<QueryClientProvider client={client}><I18nProvider><BotToolPolicies bot={bot} /></I18nProvider></QueryClientProvider>);
  const notes = await screen.findAllByText("Lire la liste des routines ne demande jamais d’autorisation.");
  expect(notes).toHaveLength(1);
});
