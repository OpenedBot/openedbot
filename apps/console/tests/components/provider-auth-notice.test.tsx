import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { PROVIDER_AUTH_REQUIRED_CODE } from "@openedbot/contracts-errors";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";
import {
  clearProviderReconnect,
  PROVIDER_AUTH_REQUIRED,
  providerAuthRequiredSlug,
  useProviderReconnectRequest,
} from "../../src/lib/runtime/provider-auth";

/**
 * Bug 1b (2026-10-24): an expired xAI login is no longer answered by another
 * provider. The failed turn says which provider refused the bot's login and
 * opens Models, where the operator reconnects it.
 */

const speechAdapter: SpeechSynthesisAdapter = {
  supported: false,
  voices: () => [],
  subscribeVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
};

const ALICE = { id: "bot-a", name: "Pilote", slug: "pilote", face: null };

function failure(payload: Record<string, unknown>): StoredProductEvent {
  return {
    cursor: 1, sequence: 1, runId: "run-1", type: "run.error",
    payload: { message: "xai-oauth a refusé l’authentification de ce bot.", ...payload },
    occurredAt: new Date("2026-10-24T01:00:00.000Z"),
  };
}

/** What the Models screen will read: the provider it was asked to reconnect. */
function RequestedProvider() {
  return <p data-testid="requested-provider">{useProviderReconnectRequest()?.provider ?? ""}</p>;
}

function renderTimeline(event: StoredProductEvent) {
  const root = createRootRoute({
    component: () => (
      <>
      <ThreadTimeline
        events={[event]}
        userInputs={[]}
        runs={[{ id: "run-1", status: "failed" }]}
        approvals={[]}
        running={false}
        speechAdapter={speechAdapter}
        defaultAuthor={ALICE}
      />
      <RequestedProvider />
      </>
    ),
  });
  const models = createRoute({ getParentRoute: () => root, path: "/settings/models", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([models]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<I18nProvider><RouterProvider router={router} /></I18nProvider>);
  return router;
}

beforeEach(() => window.localStorage.setItem("openedbot:locale", "fr"));
afterEach(() => {
  cleanup();
  clearProviderReconnect();
});

describe("PROVIDER_AUTH_REQUIRED in the thread", () => {
  test("names the provider and opens Models on that provider to reconnect it", async () => {
    const router = renderTimeline(failure({ errorCode: PROVIDER_AUTH_REQUIRED, provider: "xai-oauth" }));
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Pilote ne peut pas répondre : xAI a refusé sa connexion. Reconnectez xAI dans Réglages → Modèles.");
    fireEvent.click(screen.getByRole("button", { name: "Reconnecter xAI" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe("/settings/models");
    // Models is asked for xAI's dialog, not only for the screen.
    expect((await screen.findByTestId("requested-provider")).textContent).toBe("xai-oauth");
  });

  test("without a valid provider the raw message stays, without an action", async () => {
    renderTimeline(failure({ errorCode: PROVIDER_AUTH_REQUIRED, provider: "../x" }));
    expect(await screen.findByText("xai-oauth a refusé l’authentification de ce bot.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("the console constant keeps the wire value of the contracts", () => {
    expect(PROVIDER_AUTH_REQUIRED).toBe(PROVIDER_AUTH_REQUIRED_CODE);
    expect(providerAuthRequiredSlug({ provider: "anthropic" })).toBe("anthropic");
    expect(providerAuthRequiredSlug({ provider: 4 })).toBeNull();
  });
});
