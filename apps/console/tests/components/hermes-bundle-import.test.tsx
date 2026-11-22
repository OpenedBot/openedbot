import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../src/lib/i18n";
import { api, queryKeys } from "../../src/lib/api";
import { HermesBundleImport } from "../../src/components/hermes-bundle-import";
import type { HermesBundleImportJobDto } from "@openedbot/contracts-api";
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => { cleanup(); for (const mock of mocks.splice(0)) mock.mockRestore(); window.localStorage.clear(); });
const job: HermesBundleImportJobDto = {
  id: "job-1", runtimeId: "runtime-1", status: "succeeded", phase: "finished", completedProfiles: 1, totalProfiles: 1,
  createdAt: "2026-09-07T10:00:00Z", updatedAt: "2026-09-07T10:01:00Z", error: null,
  result: { imported: [{ slug: "scout", botId: "bot-1", threadId: "thread-1", name: "Scout" }], skipped: [], routines: [], groups: [], limitations: [], capabilities: [] },
};
function mount() {
  window.localStorage.setItem("openedbot:locale", "fr");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<I18nProvider><QueryClientProvider client={client}><HermesBundleImport /></QueryClientProvider></I18nProvider>);
  return { ...rendered, client };
}
test("recovers completed report after remount; network failure retains it until Continue", async () => {
  const fetchJobs = spyOn(api, "hermesImportJobs").mockResolvedValue({ jobs: [job], nextCursor: null }); mocks.push(fetchJobs);
  // The imported agent's settings row: its name, its slug in mono under it.
  const scoutRow = () => screen.queryAllByText("scout", { selector: "[data-settings-row] .font-mono" }).find((slug) => slug.closest("[data-settings-row]")?.textContent?.includes("Scout")) ?? null;
  const first = mount();
  await waitFor(() => expect(scoutRow()).not.toBeNull());
  first.unmount(); const second = mount();
  await waitFor(() => expect(scoutRow()).not.toBeNull());
  fetchJobs.mockRejectedValue(new Error("offline"));
  await second.client.refetchQueries({ queryKey: queryKeys.hermesImportJobs });
  await waitFor(() => expect(screen.getByText(/Le suivi est indisponible/)).toBeTruthy());
  expect(scoutRow()).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
  expect(scoutRow()).toBeNull();
  expect(screen.getByLabelText("Agents depuis une archive Hermes", { selector: "input" })).toBeTruthy();
});
test("acknowledgement requires explicit verification and displays uncertain names", async () => {
  mocks.push(spyOn(api, "hermesImportJobs").mockResolvedValue({ jobs: [{ ...job, status: "needs_attention", error: { code: "PROFILE_IMPORT_UNCONFIRMED", message: "Vérifiez", details: { unconfirmedProfiles: ["uncertain"] } } }], nextCursor: null }));
  const acknowledge = spyOn(api, "acknowledgeHermesImport").mockResolvedValue(job); mocks.push(acknowledge);
  mount();
  await waitFor(() => expect(screen.getByText(/Vérifiez uncertain/)).toBeTruthy());
  const button = screen.getByRole("button", { name: "Acquitter la vérification sur l’hôte" });
  expect(button).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
  await waitFor(() => expect(acknowledge).toHaveBeenCalledWith(job.id));
});
