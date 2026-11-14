/** Calendar days in UTC, with an inclusive start and exclusive end. */
export type MetricsPeriod = { days: number; from: string; until: string; timezone: "UTC" };

/** openedbot's own ledger, never the provider account's total usage or a bill. */
export type WorkspaceBusinessMetrics = {
  activeBots: number;
  archivedBots: number;
  runsTotal: number;
  runsRunning: number;
  runsQueued: number;
  pendingApprovals: number;
  completed: number;
  failed: number;
  tokens: number;
  tokensMeasuredRuns: number;
  tokensUnknownRuns: number;
  successRate: number | null;
  providerIncidents: number;
  runtimeIncidents: number;
};
