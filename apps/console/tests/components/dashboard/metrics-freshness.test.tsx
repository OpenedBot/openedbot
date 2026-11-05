import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OverviewDto, UsageDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { api, queryKeys } from "../../../src/lib/api";
import { SectionCards } from "../../../src/components/dashboard/section-cards";
import { ChartAreaInteractive } from "../../../src/components/dashboard/chart-area-interactive";
import { TokensChart } from "../../../src/components/dashboard/tokens-chart";

const spies: Array<{ mockRestore(): void }> = [];
const clients: QueryClient[] = [];

const emptyOverview: OverviewDto = {
  bots: 0,
  runsTotal: 0,
  runsRunning: 0,
  awaitingApproval: 0,
  completed: 0,
  failed: 0,
  tokens: 0,
  successRate: null,
  activity: [],
};

const emptyUsage: UsageDto = { day: [], week: [], month: [], year: [] };

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  for (const spy of spies.splice(0)) spy.mockRestore();
  window.localStorage.clear();
});

function renderMetrics(client = new QueryClient()) {
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <div>
          <SectionCards flush />
          <ChartAreaInteractive />
          <TokensChart />
        </div>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return client;
}

test("a valid empty response shows zero and the empty chart states", async () => {
  spies.push(spyOn(api, "overview").mockResolvedValue(emptyOverview));
  spies.push(spyOn(api, "usage").mockResolvedValue(emptyUsage));
  renderMetrics();

  await screen.findByText("Aucune exécution sur la période.");
  expect(screen.getByText("Aucune consommation sur la période.")).toBeTruthy();
  expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a first API failure shows an error and retry instead of zero or an empty chart", async () => {
  const overview = spyOn(api, "overview")
    .mockRejectedValueOnce(new Error("API unavailable"))
    .mockResolvedValue(emptyOverview);
  spies.push(overview);
  spies.push(
    spyOn(api, "usage").mockRejectedValue(new Error("API unavailable")),
  );
  renderMetrics();

  const retries = await screen.findAllByRole("button", { name: "Réessayer" });
  const retry = retries[0]!;
  expect(screen.getAllByRole("alert").length).toBeGreaterThanOrEqual(3);
  expect(
    screen.getAllByText("Ces chiffres ne sont pas disponibles pour le moment.")
      .length,
  ).toBe(3);
  expect(screen.queryByText("Aucune exécution sur la période.")).toBeNull();
  expect(screen.queryByText("Aucune consommation sur la période.")).toBeNull();

  fireEvent.click(retry);
  await screen.findByText("Bots");
  await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getAllByText(
        "Ces chiffres ne sont pas disponibles pour le moment.",
      ).length,
    ).toBe(1),
  );
});

test("a failed refresh keeps the last successful metrics with their API response date", async () => {
  const observedAt = Date.now() - 5 * 60_000;
  const previousOverview: OverviewDto = {
    ...emptyOverview,
    bots: 7,
    runsTotal: 8,
  };
  const client = new QueryClient();
  client.setQueryData(queryKeys.overview, previousOverview, {
    updatedAt: observedAt,
  });
  client.setQueryData(queryKeys.usage, emptyUsage, { updatedAt: observedAt });
  spies.push(
    spyOn(api, "overview").mockRejectedValue(new Error("API unavailable")),
  );
  spies.push(
    spyOn(api, "usage").mockRejectedValue(new Error("API unavailable")),
  );
  renderMetrics(client);

  await waitFor(() =>
    expect(screen.getAllByText(/Dernière réponse API/).length).toBe(3),
  );
  expect(screen.getByText("7")).toBeTruthy();
  expect(screen.getByText(/0 jetons sur la période affichée/)).toBeTruthy();
  expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(3);
  expect(screen.queryByRole("alert")).toBeNull();
});
