import type { HermesReasoningEffort, RuntimeHealthStatus } from "@openedbot/contracts-api";

export const NONE = "__none__";
/** Reread of the configuration, and of an unreachable runtime's catalog. */
export const RUNTIME_POLL_MS = 3_000;
/** Reread of the configuration while a model is checked in the background. */
export const SELECTION_POLL_MS = 1_500;

/**
 * The page's column on desktop: the pane's whole width, like the other
 * settings pages (a bounded column left an empty strip on the right). The
 * skeleton takes the same column, so nothing slides when the data arrives.
 */
export const MODELS_COLUMN = "flex w-full flex-col gap-8";

/**
 * The bot table's grid (`PerBotModelsTable`), shared with its skeleton so
 * the selectors do not slide when the data arrives. A container query, not
 * the window: the pane is narrower than the viewport by the rail and the
 * settings menu. Narrow, the bot takes the first line and its two selectors
 * share the second; wide, the name column absorbs the width and the
 * selectors keep a bounded size on the right, like a `ListRow` control.
 */
export const BOT_TABLE_GRID =
  "grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-x-3 gap-y-2 @xl:grid-cols-[minmax(10rem,1fr)_minmax(11rem,18rem)_minmax(8rem,11rem)]";
/** The bot cell: alone on its line until the table is wide enough. */
export const BOT_TABLE_BOT_CELL = "col-span-full @xl:col-span-1";
/** The column band (`DATA_TABLE.headRow`'s colors), hidden while the grid is stacked. */
export const BOT_TABLE_HEAD =
  "hidden border-b border-border/60 bg-background-secondary-default px-4 py-2 text-xs font-medium text-muted-foreground dark:bg-white/5 @xl:grid";

export type Preference = {
  provider: string | null;
  model: string | null;
  effort: HermesReasoningEffort | null;
};

export type AssignmentMode = "global" | "perBot";

export type RuntimeOffline = {
  status: Extract<RuntimeHealthStatus, "disconnected" | "unreachable">;
  /** Last sign of life of the link, timestamped by the server; `null` if there is none. */
  since: string | null;
  /** End of the last reread (successful or not) of the request that will lift the veil, in ms. */
  lastAttemptAt: number;
  /** This request is in flight. */
  checking: boolean;
};
