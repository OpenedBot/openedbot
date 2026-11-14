export type ActivityPoint = { date: string; completed: number; failed: number; tokens: number };

export type OverviewDto = {
  bots: number;
  runsTotal: number;
  runsRunning: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  tokens: number;
  successRate: number | null;
  activity: ActivityPoint[];
};

/** A token-usage point, aggregated over a calendar bucket (`date` = start of the bucket). */
export type UsagePoint = { date: string; inputTokens: number; outputTokens: number; totalTokens: number };

export type UsageDto = { day: UsagePoint[]; week: UsagePoint[]; month: UsagePoint[]; year: UsagePoint[] };

/** Breakdown of finished runs by model sent to Hermes, over `windowDays`. */
type ModelUsageRowDto = {
  model: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  lastAt: string;
};

export type ModelUsageDto = { windowDays: number; models: ModelUsageRowDto[] };

/** Exact openedbot consumption per bot, whatever provider attribution is displayed. */
type BotUsageRowDto = {
  botId: string;
  name: string;
  slug: string;
  model: string | null;
  lastModel: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  lastAt: string | null;
};

export type BotUsageDto = { windowDays: number; bots: BotUsageRowDto[] };
