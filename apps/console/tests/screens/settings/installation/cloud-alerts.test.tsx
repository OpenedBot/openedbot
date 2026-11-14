import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AlertChannelDto } from "@openedbot/contracts-api";
import { queryKeys } from "../../../../src/lib/api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { RuntimeAlertsSection } from "../../../../src/screens/settings/installation/cloud/cloud-alerts";

const realFetch = globalThis.fetch;
const WEBHOOK = `https://discord.com/api/webhooks/1459685375038591192/${"t".repeat(68)}`;

function channel(overrides: Partial<AlertChannelDto> = {}): AlertChannelDto {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    kind: "discord",
    label: "Alertes ops",
    targetHint: "discord.com/api/webhooks/1459685375038591192/…",
    enabled: true,
    createdAt: "2026-11-01T09:00:00.000Z",
    lastDeliveredAt: null,
    lastFailureAt: null,
    lastFailureStatus: null,
    lastFailureReason: null,
    ...overrides,
  };
}

type Call = { method: string; url: string; body: unknown };

function session(role: "owner" | "member") {
  return {
    kind: "session",
    sessionId: "web",
    user: { id: "user-one", email: "operator@example.com", displayName: "Operator" },
    organization: { id: "org-one", slug: "acme", name: "Acme" },
    session: { role, canWrite: true, impersonation: null },
  };
}

let role: "owner" | "member" = "owner";

function stubApi(channels: AlertChannelDto[], onCreate?: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.endsWith("/api/auth/me")) {
      return Response.json({
        user: { id: "user-one", email: "operator@example.com", displayName: "Operator" },
        organization: { id: "org-one", slug: "acme", name: "Acme" },
        role,
      });
    }
    if (url.endsWith("/api/alert-channels") && method === "GET") return Response.json({ channels, limit: 10 });
    if (url.endsWith("/api/alert-channels") && method === "POST") {
      return onCreate ? onCreate(body) : Response.json(channel({ label: String(body.label ?? "Alertes ops") }), { status: 201 });
    }
    if (url.endsWith("/test") && method === "POST") return Response.json({ delivered: true, channel: channels[0] });
    return Response.json({}, { status: 200 });
  }) as typeof fetch;
  return calls;
}

function renderSection(as: "owner" | "member" = "owner") {
  role = as;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.authMe, session(as));
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RuntimeAlertsSection />
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

describe("RuntimeAlertsSection", () => {
  test("a member is told who manages alerts and nothing is fetched", async () => {
    const calls = stubApi([]);
    renderSection("member");
    expect(await screen.findByText("Seuls les owners et admins de l’espace gèrent les alertes.")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/api/alert-channels"))).toBe(false);
  });

  test("lists channels with their state, never a webhook token", async () => {
    stubApi([
      channel(),
      channel({
        id: "c0000000-0000-4000-8000-000000000002",
        label: "Ancien salon",
        enabled: false,
        lastFailureAt: "2026-11-01T08:00:00.000Z",
        lastFailureStatus: 404,
        lastFailureReason: "webhook_revoked",
      }),
    ]);
    renderSection();
    expect(await screen.findByText("Alertes ops")).toBeTruthy();
    expect(screen.getByText("Actif")).toBeTruthy();
    expect(screen.getByText("Désactivé")).toBeTruthy();
    expect(screen.getByText(/Webhook supprimé côté Discord/)).toBeTruthy();
    expect(screen.getByText("Aucun message envoyé pour l’instant.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("t".repeat(20));
    // A disabled channel cannot be tested, only turned back on.
    const tests = screen.getAllByRole("button", { name: "Envoyer un test" }) as HTMLButtonElement[];
    expect(tests.map((button) => button.disabled)).toEqual([false, true]);
    expect(screen.getByRole("button", { name: "Réactiver" })).toBeTruthy();
  });

  test("adds a webhook, then clears the secret from the field", async () => {
    const calls = stubApi([]);
    renderSection();
    expect(await screen.findByText("Aucun canal pour l’instant. Ajoutez un webhook Discord pour être prévenu.")).toBeTruthy();
    const url = screen.getByLabelText("URL du webhook") as HTMLInputElement;
    fireEvent.change(url, { target: { value: `  ${WEBHOOK}  ` } });
    fireEvent.change(screen.getByLabelText("Nom (facultatif)"), { target: { value: "#ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ kind: "discord", webhookUrl: WEBHOOK, label: "#ops" });
    await waitFor(() => expect(url.value).toBe(""));
  });

  test("shows the API's reason when the webhook is refused, and keeps the URL to fix it", async () => {
    stubApi([], () => Response.json({
      error: { code: "ALERT_CHANNEL_WEBHOOK_NOT_FOUND", message: "Discord ne connaît pas ce webhook. Vérifiez l'URL copiée, ou recréez le webhook." },
    }, { status: 422 }));
    renderSection();
    const url = await screen.findByLabelText("URL du webhook") as HTMLInputElement;
    fireEvent.change(url, { target: { value: WEBHOOK } });
    fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Discord ne connaît pas ce webhook");
    expect(url.value).toBe(WEBHOOK);
  });

  test("removal asks for confirmation first", async () => {
    const calls = stubApi([channel()]);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Supprimer le canal « Alertes ops »" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith(`/api/alert-channels/${channel().id}`))).toBe(true));
  });
});
