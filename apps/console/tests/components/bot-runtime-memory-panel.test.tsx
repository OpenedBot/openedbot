import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto } from "@openedbot/contracts-api";
import { api } from "../../src/lib/api";
import { I18nProvider } from "../../src/lib/i18n";
import { BotMemoryPanel } from "../../src/components/bot-runtime-memory-panel";

const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => {
  cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
  window.localStorage.clear();
});

function renderWithBrief(context: string) {
  spies.push(spyOn(api, "authMe").mockResolvedValue({ kind: "session", session: { canWrite: true } } as never));
  spies.push(spyOn(api, "botRuntimeMemory").mockResolvedValue({
    available: true, profile: "scout", enabled: true,
    limits: { memory: 2200, user: 1375 }, entries: { memory: [], user: [] }, usedChars: { memory: 0, user: 0 }, message: null,
  }));
  spies.push(spyOn(api, "roster").mockResolvedValue({ bots: [], groups: [], sections: [{ id: "section-1", name: "Équipe", position: 0, collapsed: false, context }] } as never));
  const update = spyOn(api, "updateSection").mockResolvedValue({ id: "section-1" } as never);
  spies.push(update);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <BotMemoryPanel bot={{ id: "bot-1", sectionId: "section-1" } as BotDto} open />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return update;
}

test("vider le brief d'équipe enregistre un brief vide au lieu de rétablir l'ancien", async () => {
  const update = renderWithBrief("Ancien brief");
  const field = await waitFor(() => screen.getByLabelText("Brief d’équipe") as HTMLTextAreaElement);
  await waitFor(() => expect(field.value).toBe("Ancien brief"));

  fireEvent.change(field, { target: { value: "" } });
  expect(field.value).toBe("");
  fireEvent.blur(field);

  await waitFor(() => expect(update).toHaveBeenCalledWith("section-1", { context: "" }));
});

test("un champ jamais touché n'envoie rien au blur", async () => {
  const update = renderWithBrief("Ancien brief");
  const field = await waitFor(() => screen.getByLabelText("Brief d’équipe") as HTMLTextAreaElement);
  await waitFor(() => expect(field.value).toBe("Ancien brief"));
  fireEvent.blur(field);
  expect(update).not.toHaveBeenCalled();
});
