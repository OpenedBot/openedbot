import type { BotReplyLanguage } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";
import type { ActiveBotRun } from "../sql/bots";

export type { ActiveBotRun };

/**
 * What the roster asks of the execution module, which sits above it in the
 * module graph (docs/contributing/architecture.md): queue a new bot's greeting and a persona draft, and stop a bot's
 * maintenance passes before it is archived or deleted. Execution implements
 * it (`@openedbot/execution/application/bot-runs`) and the API passes it in
 * (`resolveBotDeps`, `queuePersonaDraft`): a required argument, never a
 * default, so a caller cannot forget it.
 */
export type BotRuns = {
  /** Queues the first greeting of a bot created with `greet`, in the transaction that inserts it. */
  greetNewBot(tx: TransactionDb, greeting: {
    organizationId: string;
    threadId: string;
    botId: string;
    initiatorUserId: string;
    bot: {
      name: string;
      role: string | null;
      mission: string | null;
      replyLanguage: BotReplyLanguage;
      operatorLocale?: "fr" | "en" | null;
    };
  }): Promise<void>;
  /** Queues a persona draft run on the draft thread; the run's id. */
  queuePersonaDraft(tx: TransactionDb, draft: {
    organizationId: string;
    threadId: string;
    botId: string;
    prompt: string;
    sessionKey: string;
  }): Promise<string>;
  /**
   * Cancels the maintenance passes (`memory`, `compaction`) among these locked
   * runs and returns the others, which block the archive or the purge.
   */
  stopMaintenanceRuns(
    tx: TransactionDb,
    organizationId: string,
    runs: readonly ActiveBotRun[],
    reason: { code: string; message: string },
  ): Promise<ActiveBotRun[]>;
};
