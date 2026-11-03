import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../src/lib/api";
import { I18nProvider } from "../../../src/lib/i18n";
import { pendingRosterWrites, useRosterSections } from "../../../src/components/dashboard/use-roster-sections";
import type { RosterDragRow } from "../../../src/components/dashboard/roster-drag";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  cleanup();
  while (spies.length) spies.pop()!.mockRestore();
});

// Only the fields the hook reads: the rest of a bot does not take part in ordering.
const bot = (id: string, position: number) => ({ id, name: id, sectionId: "s1", position, pinned: false, pinPosition: null });
const roster = () => ({
  bots: [bot("a", 0), bot("b", 1), bot("c", 2)],
  groups: [],
  sections: [{ id: "s1", name: "Bots", position: 0, collapsed: false }],
}) as unknown as RosterDto;
const row = (id: string, position: number) => ({ kind: "bot", bot: bot(id, position) }) as unknown as RosterDragRow;
const order = (client: QueryClient) =>
  [...client.getQueryData<RosterDto>(queryKeys.roster)!.bots].sort((x, y) => x.position - y.position).map((b) => b.id);

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.roster, roster());
  const invalidations = spyOn(client, "invalidateQueries").mockImplementation(() => Promise.resolve());
  spies.push(invalidations);
  const writes: Array<{ order: string[]; settle: (error?: Error) => void }> = [];
  const orderSpy = spyOn(api, "orderSection").mockImplementation((_sectionId, body) => new Promise<void>((resolve, reject) => {
    writes.push({ order: body.order.map((item) => item.id), settle: (error) => (error ? reject(error) : resolve()) });
  }));
  spies.push(orderSpy);
  const hook = renderHook(() => useRosterSections(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></I18nProvider>
    ),
  });
  return { client, hook, writes, invalidations };
}

test("drops show at once, their writes go out one at a time in order, and the roster is reread once at the end", async () => {
  const { client, hook, writes, invalidations } = harness();
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  act(() => { void hook.result.current.placeRow(rows[2]!, "s1", 0, rows); });
  expect(order(client)).toEqual(["c", "a", "b"]);
  const afterFirst = [row("c", 0), row("a", 1), row("b", 2)];
  act(() => { void hook.result.current.placeRow(afterFirst[2]!, "s1", 1, afterFirst); });
  // The second drop is on screen before the server has answered the first.
  expect(order(client)).toEqual(["c", "b", "a"]);
  await waitFor(() => expect(writes.length).toBe(1));
  expect(writes[0]!.order).toEqual(["c", "a", "b"]);
  expect(pendingRosterWrites(client)).toBe(2);

  await act(async () => writes[0]!.settle());
  await waitFor(() => expect(writes.length).toBe(2));
  expect(writes[1]!.order).toEqual(["c", "b", "a"]);
  // No reread between the two writes: it would bring back the middle order.
  expect(invalidations).not.toHaveBeenCalled();

  await act(async () => writes[1]!.settle());
  await waitFor(() => expect(pendingRosterWrites(client)).toBe(0));
  expect(invalidations).toHaveBeenCalledTimes(1);
});

test("a failed write does not stop the queue; the roster is reread once it drains", async () => {
  const { client, hook, writes, invalidations } = harness();
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  act(() => { void hook.result.current.placeRow(rows[2]!, "s1", 0, rows); });
  act(() => { void hook.result.current.placeRow(rows[0]!, "s1", 3, rows); });
  await waitFor(() => expect(writes.length).toBe(1));
  await act(async () => writes[0]!.settle(new Error("boom")));
  await waitFor(() => expect(writes.length).toBe(2));
  expect(invalidations).not.toHaveBeenCalled();
  await act(async () => writes[1]!.settle());
  await waitFor(() => expect(pendingRosterWrites(client)).toBe(0));
  expect(invalidations).toHaveBeenCalledTimes(1);
});

test("a row put back in its own place writes nothing", () => {
  const { hook, writes } = harness();
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  act(() => { void hook.result.current.placeRow(rows[1]!, "s1", 1, rows); });
  expect(writes.length).toBe(0);
});

test("moving a row down lands it right above the row it was dropped before", async () => {
  const { client, hook, writes } = harness();
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  // Slot 2 is "before c", counted with a still on screen.
  act(() => { void hook.result.current.placeRow(rows[0]!, "s1", 2, rows); });
  expect(order(client)).toEqual(["b", "a", "c"]);
  await waitFor(() => expect(writes[0]?.order).toEqual(["b", "a", "c"]));
});

test("dropping a row just below itself is its own place: nothing moves", () => {
  const { client, hook, writes } = harness();
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  act(() => { void hook.result.current.placeRow(rows[1]!, "s1", 2, rows); });
  expect(order(client)).toEqual(["a", "b", "c"]);
  expect(writes.length).toBe(0);
});
