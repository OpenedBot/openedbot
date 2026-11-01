import type { RunEventRecord } from "@openedbot/contracts-events";
import type { Db } from "@openedbot/platform-db";

/** Une ligne telle que le driver la rend : curseur et bail en chaîne, horodatage en Date. */
export type StoredRow = RunEventRecord & { cursor: string; leaseGeneration: string | null };

export type RunEventsDbOptions = {
  /** Appelé à chaque page de rejeu avec le curseur demandé ; peut faire attendre la page. */
  onReplayPage?: (after: number) => Promise<void> | void;
  liveRun?: { botId: string | null; turnId: string; sessionKey: string | null };
};

/**
 * `run_events` en mémoire, servi aux trois requêtes du flux (max, min de
 * fenêtre, page de rejeu). Toute autre requête est une surprise : elle échoue.
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
      // Ne rend que les colonnes que la requête nomme : une colonne oubliée
      // au SELECT manque à la trame, comme avec PostgreSQL.
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
