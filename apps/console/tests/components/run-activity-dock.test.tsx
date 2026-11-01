import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { I18nProvider } from "../../src/lib/i18n";
import { RUN_ACTIVITY_HOLD_MS, RunActivityDock } from "../../src/components/run-activity-dock";

const runs = [{ id: "run-1", status: "running", createdAt: "2026-10-24T08:00:00.000Z" } as RunDto];

function toolCall(cursor: number, tool: string, preview?: string): StoredProductEvent {
  return {
    cursor,
    sequence: cursor,
    runId: "run-1",
    type: "tool.call",
    payload: { toolCallId: `tc_${cursor}`, tool, ...(preview ? { preview } : {}) },
    occurredAt: new Date("2026-10-24T08:00:01.000Z"),
  };
}

function view(events: StoredProductEvent[]) {
  return (
    <I18nProvider>
      <RunActivityDock runs={runs} events={events} approvals={[]} running streaming />
    </I18nProvider>
  );
}

/** The status the Thinking Shimmer line shows. */
function shownLabel(container: HTMLElement): string | null | undefined {
  return container.querySelector("[data-run-activity] [data-thinking-label]")?.textContent;
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(cleanup);

describe("RunActivityDock", () => {
  test("says what the tool family does, not the tool's technical name", () => {
    const { container, unmount } = render(view([toolCall(1, "web_search")]));
    expect(shownLabel(container)).toBe("Cherche sur le web…");
    unmount();

    const mcp = render(view([toolCall(1, "mcp__notion__create_page")]));
    expect(shownLabel(mcp.container)).toBe("Travaille dans notion…");
    mcp.unmount();

    const unknown = render(view([toolCall(1, "skill_manage")]));
    expect(shownLabel(unknown.container)).toBe("Utilise skill_manage…");
  });

  test("names the query, the site and the file from the tool's preview", () => {
    const search = render(view([toolCall(1, "web_search", "cours du bitcoin en euros")]));
    expect(shownLabel(search.container)).toBe("Recherche : cours du bitcoin en euros");
    search.unmount();

    const read = render(view([toolCall(1, "web_extract", "https://www.lemonde.fr/economie/article?token=abc")]));
    expect(shownLabel(read.container)).toBe("Lecture : lemonde.fr");
    read.unmount();

    const write = render(view([toolCall(1, "write_file", "/home/bot/work/note.txt")]));
    expect(shownLabel(write.container)).toBe("Écrit note.txt");
  });

  test("holds a status at least 800 ms, then swaps to the latest one", async () => {
    const { container, rerender } = render(view([toolCall(1, "web_search")]));
    expect(shownLabel(container)).toBe("Cherche sur le web…");

    // A burst: two more tools within the hold. Only the latest is kept.
    rerender(view([toolCall(1, "web_search"), toolCall(2, "read_file")]));
    rerender(view([toolCall(1, "web_search"), toolCall(2, "read_file"), toolCall(3, "terminal")]));
    expect(shownLabel(container)).toBe("Cherche sur le web…");

    await waitFor(() => expect(shownLabel(container)).toBe("Exécute des commandes…"), {
      timeout: RUN_ACTIVITY_HOLD_MS + 1000,
    });
    // A new status mounts anew: it rises into place under the sweep.
    const label = container.querySelector("[data-run-activity] [data-thinking-label]")!;
    expect(label.classList.contains("ohb-thinking-shimmer")).toBe(true);
    expect(label.classList.contains("animate-in")).toBe(true);
  });
});
