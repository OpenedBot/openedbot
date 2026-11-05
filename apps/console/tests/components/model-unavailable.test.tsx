import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";
import {
  MODEL_UNAVAILABLE,
  modelUnavailableByBot,
  modelUnavailableMessage,
  readableRunFailure,
} from "../../src/lib/run/model-unavailable";

/**
 * DEV-329 : un modèle refusé par le fournisseur se lit comme tel dans le fil
 * (au lieu du « HTTP 400 » brut), avec l'action qui corrige ; les autres
 * échecs gardent leur bulle.
 */

const speechAdapter: SpeechSynthesisAdapter = {
  supported: false,
  voices: () => [],
  subscribeVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
};

const ALICE = { id: "bot-a", name: "Alice", slug: "alice", face: null };

function failure(payload: Record<string, unknown>): StoredProductEvent {
  return {
    cursor: 1, sequence: 1, runId: "run-1", type: "run.error",
    payload: { message: "HTTP 400: Upstream request failed: Model is unavailable.", ...payload },
    occurredAt: new Date("2026-10-14T10:00:00.000Z"),
  };
}

function renderTimeline(event: StoredProductEvent, run: Record<string, unknown> = {}) {
  const root = createRootRoute({
    component: () => (
      <ThreadTimeline
        events={[event]}
        userInputs={[]}
        runs={[{ id: "run-1", status: "failed", ...run }]}
        approvals={[]}
        running={false}
        speechAdapter={speechAdapter}
        defaultAuthor={ALICE}
      />
    ),
  });
  const bot = createRoute({ getParentRoute: () => root, path: "/bot/$botId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([bot]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<I18nProvider><RouterProvider router={router} /></I18nProvider>);
  return router;
}

beforeEach(() => window.localStorage.setItem("openedbot:locale", "fr"));
afterEach(cleanup);

describe("bulle d'un échec dans le fil", () => {
  test("MODEL_UNAVAILABLE : message lisible et « Changer le modèle » vers le bot", async () => {
    const router = renderTimeline(failure({ errorCode: MODEL_UNAVAILABLE }), { model: "gpt-9" });
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Alice ne peut pas répondre : le modèle gpt-9 n'est plus disponible.");
    expect(screen.queryByText(/HTTP 400/)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Changer le modèle" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe("/bot/bot-a");
  });

  test("le code du run suffit quand l'événement relu n'en porte pas", async () => {
    renderTimeline(failure({}), { errorCode: MODEL_UNAVAILABLE, model: "gpt-9" });
    expect((await screen.findByRole("alert")).textContent).toContain("le modèle gpt-9");
  });

  test("sans modèle connu, la phrase n'en invente pas", async () => {
    renderTimeline(failure({ errorCode: MODEL_UNAVAILABLE }));
    expect((await screen.findByRole("alert")).textContent).toContain("Alice ne peut pas répondre : son modèle n'est plus disponible.");
  });

  test("un autre échec garde le texte brut, sans action", async () => {
    renderTimeline(failure({ errorCode: "HERMES_RUN_FAILED", message: "Le runtime a coupé." }), { errorCode: "HERMES_RUN_FAILED" });
    expect(await screen.findByText("Le runtime a coupé.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link", { name: "Changer le modèle" })).toBeNull();
  });
});

describe("modèle indisponible : règles partagées", () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}|${params?.name ?? ""}|${params?.model ?? ""}`;

  // La console ne dépend pas de `@openedbot/contracts-errors` : la valeur filaire est
  // épinglée ici et dans `modules/execution/tests/hermes-events.test.ts`.
  test("la constante de la console garde la valeur filaire des contrats", () => {
    expect(MODEL_UNAVAILABLE).toBe("MODEL_UNAVAILABLE");
  });

  test("le toast reprend le message lisible, et rien pour un autre code", () => {
    const run = { error: "HTTP 400", errorCode: MODEL_UNAVAILABLE, model: "gpt-9" };
    expect(readableRunFailure(t as never, run, "Alice")).toBe("threadTimeline.modelUnavailable|Alice|gpt-9");
    expect(readableRunFailure(t as never, { ...run, errorCode: "WORKER_RUN_FAILED" }, "Alice")).toBeNull();
    expect(modelUnavailableMessage(t as never, "Alice", "  ")).toBe("threadTimeline.modelUnavailableNoModel|Alice|");
  });

  function run(id: string, botId: string, status: RunDto["status"], createdAt: string, extra: Partial<RunDto> = {}) {
    return { id, botId, status, createdAt, ...extra };
  }

  test("l'alerte tient jusqu'à un tour réussi du même membre", () => {
    const refused = run("r1", "bot-a", "failed", "2026-10-14T10:00:00Z", { errorCode: MODEL_UNAVAILABLE, model: "gpt-9" });
    expect(modelUnavailableByBot([refused]).get("bot-a")).toEqual({ runId: "r1", model: "gpt-9" });
    // Un tour en cours ne tranche pas.
    expect(modelUnavailableByBot([refused, run("r2", "bot-a", "running", "2026-10-14T10:05:00Z")]).has("bot-a")).toBe(true);
    // Un tour réussi plus tard l'efface ; un autre membre n'est pas touché.
    const fixed = [refused, run("r3", "bot-a", "completed", "2026-10-14T10:06:00Z"), run("r4", "bot-b", "completed", "2026-10-14T10:06:00Z")];
    expect(modelUnavailableByBot(fixed).size).toBe(0);
    // Un échec antérieur au succès ne ressuscite pas, quel que soit l'ordre du tableau.
    expect(modelUnavailableByBot([fixed[1]!, refused]).size).toBe(0);
  });
});
