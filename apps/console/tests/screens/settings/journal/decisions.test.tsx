import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../../src/lib/i18n";
import { SETTINGS_GROUPS } from "../../../../src/components/dashboard/settings-sidebar";
import { DecisionsSettings } from "../../../../src/screens/settings/journal/decisions";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const DECISION = {
  id: "d1",
  runId: "run-1",
  botId: "bot-1",
  botName: "Atlas",
  action: "touch /tmp/audit-proof",
  kind: "shell",
  choice: "once" as const,
  origin: "human" as const,
  policy: null,
  approverUserId: "user-1",
  approverRole: "owner",
  entryHash: "hash",
  issuedAt: "2026-08-31T12:00:00.000Z",
};

function stubFetch(decisions: unknown[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = href(input);
    if (url.includes("/api/decisions")) return Response.json({ decisions });
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderDecisions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <DecisionsSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("DecisionsSettings", () => {
  test("la barre des réglages expose /settings/decisions", () => {
    const urls = SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.url));
    expect(urls).toContain("/settings/decisions");
  });

  test("affiche bot, action et type remontés par l'API", async () => {
    stubFetch([DECISION]);
    renderDecisions();
    await waitFor(() => {
      expect(screen.getByText("Atlas")).toBeTruthy();
    });
    expect(screen.getByText("touch /tmp/audit-proof")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
    expect(screen.getByText("Autorisée")).toBeTruthy();
  });

  const TRACE = {
    stage: null, decidedBy: null, deciderName: null, reason: null, heldBy: null,
    grant: null, always: null, humanOverridden: null, policyChanged: false,
  };

  test("PERM2-11 : une gate approuvée par grant affiche le grant et son auteur", async () => {
    stubFetch([{
      ...DECISION, id: "a1", origin: "policy", policy: "auto", approverUserId: null, approverRole: "", entryHash: null,
      trace: {
        ...TRACE, stage: "grant", decidedBy: "policy", reason: "grant",
        grant: { kind: "bot_tool", authorName: "Camille Lefèvre", authorKind: "member", fromAlways: true, createdAt: "2026-08-30T08:00:00.000Z", revoked: false },
      },
    }]);
    renderDecisions();
    await waitFor(() => expect(screen.getByText("Décidé par la politique : grant")).toBeTruthy());
    expect(screen.getByText("Motif : grant « Toujours » actif")).toBeTruthy();
    expect(screen.getByText(/^Grant créé par « Toujours » de Camille Lefèvre le /)).toBeTruthy();
  });

  test("PERM2-11 : une gate retenue par le plancher affiche la règle et la personne qui a tranché", async () => {
    stubFetch([{
      ...DECISION, choice: "deny",
      trace: { ...TRACE, stage: "floor", decidedBy: "member", deciderName: "Camille Lefèvre", reason: "sensitive_path" },
    }]);
    renderDecisions();
    await waitFor(() => expect(screen.getByText("Décidé par Camille Lefèvre")).toBeTruthy());
    expect(screen.getByText("Demandée à une personne : chemin sensible")).toBeTruthy();
  });

  test("PERM2-11 : une routine sans attente dit quel palier aurait retenu la gate", async () => {
    stubFetch([{
      ...DECISION, choice: "deny", origin: "policy", policy: "manual", approverUserId: null, entryHash: null,
      trace: { ...TRACE, stage: "unattended", decidedBy: "policy", reason: "never_wait", heldBy: { stage: "floor", reason: "circuit_breaker" } },
    }]);
    renderDecisions();
    await waitFor(() => expect(screen.getByText("Décidé par la politique : routine sans attente")).toBeTruthy());
    expect(screen.getByText("Personne ne répond à cette routine ; elle aurait attendu : commande à risque majeur (disjoncteur)")).toBeTruthy();
  });

  test("une réponse d'une API sans trace reste lisible", async () => {
    stubFetch([DECISION]);
    renderDecisions();
    await waitFor(() => expect(screen.getByText("Atlas")).toBeTruthy());
    expect(document.querySelector("[data-decision-trace]")).toBeNull();
  });
});
