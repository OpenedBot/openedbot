import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotProfileStatusDto } from "@openedbot/contracts-api";
import { BotProfileRepair } from "../../src/components/bot-profile-repair";
import { api } from "../../src/lib/api";
import { I18nProvider } from "../../src/lib/i18n";

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

const status: BotProfileStatusDto = {
  profile: "scout", state: "missing", canRepair: true, carried: [], lost: [],
};

test("the missing profile can be closed without resetting or transferring the bot", () => {
  let exits = 0;
  const repair = spyOn(api, "repairBotProfile");
  try {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <BotProfileRepair bot={{ id: "bot-scout", name: "Scout" }} status={status} onClose={() => { exits++; }} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retour à l’accueil" }));
    expect(exits).toBe(1);
    expect(repair).not.toHaveBeenCalled();
  } finally { repair.mockRestore(); }
});
