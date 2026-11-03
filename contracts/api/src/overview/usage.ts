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

/** Un point d'usage de jetons, agrégé sur un bucket calendaire (`date` = début du bucket). */
export type UsagePoint = { date: string; inputTokens: number; outputTokens: number; totalTokens: number };

export type UsageDto = { day: UsagePoint[]; week: UsagePoint[]; month: UsagePoint[]; year: UsagePoint[] };

/** Ventilation des runs achevés par modèle envoyé à Hermes, sur `windowDays`. */
type ModelUsageRowDto = {
  model: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  lastAt: string;
};

export type ModelUsageDto = { windowDays: number; models: ModelUsageRowDto[] };

/** Consommation openedbot exacte par bot, quelle que soit l'attribution fournisseur affichée. */
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
