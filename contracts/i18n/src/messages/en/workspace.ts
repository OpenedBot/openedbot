/** English strings, one file per domain: `messages.en.ts` assembles them. */

export const sectionCards = {
  title: "Key figures",
  description: "The organization at a glance, read again every 15 seconds.",
  botsLabel: "Bots",
  conversationsBadge: "conversations",
  botsFooterTitle: "One thread and one memory per bot",
  botsFooterSubtitle: "Each keeps its own model",
  runsLabel: "Runs",
  runsRunningBadge: "{count} running",
  runsFooterTitle: "{completed} completed · {failed} failed",
  runsFooterSubtitle: "Since the first launch",
  pendingLabel: "Pending decisions",
  pendingBadgeYes: "to decide",
  pendingBadgeNo: "nothing to do",
  pendingFooterTitleYes: "A bot is waiting for your approval",
  pendingFooterTitleNo: "No action blocked",
  pendingFooterSubtitle: "No risky action without a decision",
  successRateLabel: "Success rate",
  successRateEmpty: ":",
  successRateValue: "{rate} %",
  tokensBadge: "{count} tokens",
  successRateFooterTitleYes: "No run completed yet",
  successRateFooterTitleNo: "On completed runs",
  successRateFooterSubtitle: "Cancellations do not count",
} as const;

export const dashboardMetrics = {
  unavailable: "These figures are unavailable right now.",
  stale: "These values are stale. Latest API response: {date}.",
} as const;

export const chartArea = {
  title: "Bot activity",
  descriptionFull: "Completed and failed runs, per day",
  descriptionShort: "Runs per day",
  range90d: "Last 3 months",
  range30d: "Last 30 days",
  range7d: "Last 7 days",
  periodAriaLabel: "Choose the period",
  emptyTitle: "No run over this period.",
  emptySubtitle: "The chart fills in as soon as the first message arrives.",
  seriesCompleted: "Completed",
  seriesFailed: "Failed",
} as const;

export const chartTokens = {
  title: "Token usage",
  descriptionFull: "Tokens used by runs, per period",
  descriptionShort: "Tokens used",
  totalForPeriod: "{count} tokens over the displayed period",
  granularityAriaLabel: "Choose the granularity",
  granularityDay: "Daily",
  granularityWeek: "Weekly",
  granularityMonth: "Monthly",
  granularityYear: "Yearly",
  weekOf: "Week of {date}",
  emptyTitle: "No usage over this period.",
  emptySubtitle: "Tokens will appear after the first run.",
  seriesInput: "Input tokens",
  seriesOutput: "Output tokens",
} as const;
