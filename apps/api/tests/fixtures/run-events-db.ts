import type { RunEventRecord } from "@openedbot/contracts-events";
import type { Db } from "@openedbot/platform-db";

/** A row as the driver returns it: cursor and lease as strings, timestamp as a Date. */
export type StoredRow = RunEventRecord & { cursor: string; leaseGeneration: string | null };

export type RunEventsDbOptions = {
  /** Called on each replay page with the requested cursor; may make the page wait. */
  onReplayPage?: (after: number) => Promise<void> | void;
  liveRun?: { botId: string | null; turnId: string; sessionKey: string | null };
};

/**
 * In-memory `run_events`, served to the stream's three queries (max, window
 * min, replay page). Any other query is a surprise: it fails.
 */
export function fakeRunEventsDb(rows: StoredRow[], options: RunEventsDbOptions = {}): Db {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("set_config")) return Promise.resolve([]);
    if (text.includes("from runs run") && text.includes("for share of run")) {
      return Promise.resolve(options.liveRun ? [options.liveRun] : []);
    }
    if (text.includes("max(cursor)")) {
      return Promise.resolve([{ max: rows.length ? Math.max(...rows.map((row) => Number(row.cursor))) : null }]);
    }
    if (text.includes("min(cursor)")) {
      return Promise.resolve([{ min: rows.length ? Math.min(...rows.map((row) => Number(row.cursor))) : null }]);
    }
    if (text.includes("from run_events") && text.includes("cursor >")) {
      const after = Number(values[1]);
      // Returns only the columns the query names: a forgotten column
      // is missing from the frame, as with PostgreSQL.
      const selected = (key: string) =>
        text.includes(`as "${key}"`) || new RegExp(`(select|,)\\s*${key}\\s*[,\\n]`).test(text);
      return Promise.resolve(options.onReplayPage?.(after)).then(() => rows
        .filter((row) => Number(row.cursor) > after)
        .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => selected(key)))));
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  }) as unknown;
  return { begin: async (callback: (inner: unknown) => unknown) => callback(tx) } as unknown as Db;
}
