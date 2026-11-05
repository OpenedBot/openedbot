import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { GateCard, PendingApprovalDock } from "../../src/components/gate-card";

const realFetch = globalThis.fetch;
const approval: ApprovalRequestDto = {
  id: "approval-1",
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-1",
  kind: "terminal",
  action: "printf one\nprintf two\nprintf three\nprintf four\nprintf five\nprintf six",
  detail: "Exécuter une commande locale en lecture seule.",
  choices: ["deny", "once"],
  status: "pending",
  requestedAt: "2026-09-03T00:00:00.000Z",
  respondedAt: null,
};

function renderWithClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  globalThis.fetch = realFetch;
});

describe("autorisation Hermes", () => {
  test("la timeline garde une trace sans dupliquer les décisions", () => {
    let requested = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      requested = true;
      return Response.json({});
    }) as typeof fetch;
    const { container } = renderWithClient(<GateCard approval={approval} mode="summary" />);
    const summary = container.querySelector<HTMLElement>("[data-approval-summary]");
    expect(summary).not.toBeNull();
    expect(screen.getByText("Décision disponible près du champ de message.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refuser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Autoriser une fois" })).toBeNull();
    fireEvent.keyDown(summary!, { key: "Escape" });
    expect(requested).toBe(false);
  });

  test("le dock montre toute l'action et traite les autorisations une par une", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Response.json({ choice: "once", approved: true });
    }) as typeof fetch;
    const second = { ...approval, id: "approval-2", action: "pwd" };
    const { container } = renderWithClient(
      <PendingApprovalDock approvals={[approval, second]} requester="Cahier2" />,
    );

    expect(container.querySelector("[data-approval-dock]")).not.toBeNull();
    expect(screen.getByText("Cahier2")).toBeTruthy();
    expect(screen.getByRole("group", { name: /Cahier2 demande votre autorisation/ })).toBeTruthy();
    expect(screen.getByText("1 sur 2")).toBeTruthy();
    expect(screen.getByText("printf six")).toBeTruthy();
    expect(container.querySelector("ol")?.parentElement?.className).toContain("max-h-40");
    expect(screen.queryByText(/ligne masquée/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Autoriser une fois" }));
    await waitFor(() => expect(requestBody).toContain('"choice":"once"'));
  });

  test("PERM2-7 : dit pourquoi la revue auto laisse décider, motif en texte brut", () => {
    const note = "<b>Le fil</b> ne demande pas **cette** suppression.";
    const { container, rerender } = renderWithClient(
      <GateCard approval={{ ...approval, review: { reason: "review_escalated", note } }} mode="dock" />,
    );
    const line = container.querySelector<HTMLElement>("[data-approval-review]");
    expect(line?.textContent).toBe(`La revue auto vous laisse décider\u00a0: ${note}`);
    expect(line?.querySelector("b, strong")).toBeNull();

    const client = new QueryClient();
    const view = (review: ApprovalRequestDto["review"]) => (
      <QueryClientProvider client={client}>
        <I18nProvider><GateCard approval={{ ...approval, review }} mode="dock" /></I18nProvider>
      </QueryClientProvider>
    );
    rerender(view({ reason: "review_timeout", note: "ignoré" }));
    expect(container.querySelector("[data-approval-review]")?.textContent).toBe("La revue auto n’a pas répondu à temps.");
    rerender(view({ reason: "review_circuit_open", note: null }));
    expect(container.querySelector("[data-approval-review]")?.textContent)
      .toBe("Plusieurs refus de suite\u00a0: la revue auto vous laisse décider.");
    rerender(view({ reason: "review_runtime_busy", note: null }));
    expect(container.querySelector("[data-approval-review]")?.textContent).toContain("max_concurrent_runs");
    rerender(view({ reason: "review_escalated", note: null }));
    expect(container.querySelector("[data-approval-review]")?.textContent).toBe("La revue auto vous laisse décider.");
    rerender(view(null));
    expect(container.querySelector("[data-approval-review]")).toBeNull();
  });
});

describe("gate de plugin identifiée", () => {
  const writeGate: ApprovalRequestDto = {
    ...approval,
    kind: "write_file",
    action: "<write_file> (plugin approval rule)",
    detail: "Approve write-capable tool write_file.",
    toolKey: "write_file",
    gateArgs: { path: "notes/plan.md", size: 12 },
  };

  test("la phrase de la console remplace le texte anglais du plugin, replié en détail", () => {
    const { container } = renderWithClient(<GateCard approval={writeGate} mode="dock" />);
    expect(container.querySelector("[data-approval-phrase]")?.textContent).toBe("write_file veut écrire : notes/plan.md");
    expect(screen.queryByText(/Approve write-capable/)).toBeNull();
    expect(screen.queryByText(/plugin approval rule/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Détails techniques" }));
    expect(screen.getByText(/Approve write-capable/)).toBeTruthy();
    expect(screen.getByText(/plugin approval rule/)).toBeTruthy();
  });

  test("sans identité prouvée, le texte brut reste affiché", () => {
    renderWithClient(<GateCard approval={{ ...writeGate, toolKey: null, gateArgs: null }} mode="dock" />);
    expect(screen.getByText("Approve write-capable tool write_file.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Détails techniques" })).toBeNull();
  });
});

describe("PERM2-4 « Toujours » sur la carte", () => {
  test("sans offre du serveur, aucun troisième bouton", () => {
    renderWithClient(<GateCard approval={approval} mode="dock" />);
    expect(screen.queryByRole("button", { name: /Toujours/ })).toBeNull();
  });

  test("le grant de l'outil part comme choix étendu", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Response.json({ decision: { id: "d-1", entryHash: "h" }, always: { choice: "always_bot_tool", saved: true } }, { status: 202 });
    }) as typeof fetch;
    renderWithClient(<GateCard approval={{ ...approval, alwaysOffered: "always_bot_tool" }} mode="dock" />);
    expect(screen.queryByText(/tous les bots de ce runtime/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toujours pour cet outil sur ce bot" }));
    await waitFor(() => expect(requestBody).toContain('"choice":"always_bot_tool"'));
  });

  test("l'interrupteur terminal avertit qu'il vaut pour tous les bots du runtime", () => {
    renderWithClient(<GateCard approval={{ ...approval, alwaysOffered: "always_runtime_terminal" }} mode="dock" />);
    const button = screen.getByRole("button", { name: "Toujours autoriser les commandes jugées dangereuses sur ce runtime" });
    const warning = screen.getByText("Toutes les commandes jugées dangereuses seront autorisées pour tous les bots de ce runtime.");
    expect(button.getAttribute("aria-describedby")).toBe(warning.id);
  });
});
