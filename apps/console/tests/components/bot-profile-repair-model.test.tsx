import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotProfileRepairDto, BotProfileStatusDto, RuntimeConfigurationDto, RuntimeModelCatalogDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { BotProfileRepair } from "../../src/components/bot-profile-repair";
import { api } from "../../src/lib/api";
import { I18nProvider } from "../../src/lib/i18n";

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

const status: BotProfileStatusDto = {
  profile: "scout", state: "missing", canRepair: true, needsModel: { transfer: false, reset: true }, carried: [], lost: [],
};

const catalog = {
  providers: [
    { slug: "xai-oauth", name: "xAI Grok OAuth", authenticated: true, models: [{ id: "grok-4.6", fast: true, reasoning: true }] },
    { slug: "anthropic", name: "Anthropic", authenticated: false, models: [] },
  ],
} as unknown as RuntimeModelCatalogDto;

test("a runtime without a model makes the reset wait for the operator's pick, then sends it", async () => {
  const runtimes = spyOn(api, "runtimeConfiguration").mockResolvedValue({ runtime: { id: "runtime-1" } as RuntimePublicDto } as RuntimeConfigurationDto);
  const models = spyOn(api, "runtimeModels").mockResolvedValue(catalog);
  const repair = spyOn(api, "repairBotProfile").mockResolvedValue({ mode: "reset", profile: "scout" } as BotProfileRepairDto);
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <BotProfileRepair bot={{ id: "bot-scout", name: "Scout" }} status={status} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const reset = screen.getByRole("button", { name: "Réinitialiser le bot" }) as HTMLButtonElement;
    const transfer = screen.getByRole("button", { name: "Transférer sur ce runtime" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    // The transfer keeps the bot's own model: it needs no pick.
    expect(transfer.disabled).toBe(false);

    const trigger = screen.getByRole("combobox", { name: "Modèle du bot" });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "grok-4.6" }));
    await waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    await waitFor(() => expect(repair).toHaveBeenCalledWith("bot-scout", "reset", { provider: "xai-oauth", model: "grok-4.6" }));
  } finally {
    runtimes.mockRestore();
    models.mockRestore();
    repair.mockRestore();
  }
});
