import type { BotRuns } from "@openedbot/roster/application/bot-runs";
import { botGreetingInput } from "../domain/bot-greeting";
import { cancelMaintenanceRunsTx, isMaintenanceStepKind } from "./run-cancellation";
import { greetNewBotTx, queuePersonaDraftRunTx } from "./run-creation";

/** The runs the roster asks for (`BotRuns`), created and cancelled by this module's commands. */
export const botRuns: BotRuns = {
  async greetNewBot(tx, { bot, ...greeting }) {
    await greetNewBotTx(tx, { ...greeting, input: botGreetingInput(bot) });
  },
  queuePersonaDraft: (tx, draft) => queuePersonaDraftRunTx(tx, draft),
  async stopMaintenanceRuns(tx, organizationId, runs, reason) {
    await cancelMaintenanceRunsTx(tx, organizationId, runs.filter((run) => isMaintenanceStepKind(run.stepKind)), reason);
    return runs.filter((run) => !isMaintenanceStepKind(run.stepKind));
  },
};
