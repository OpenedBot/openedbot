/**
 * Bench: bot creation to its first question. Each sample
 * creates a bot with the greeting, follows the greeting run, then purges the
 * bot and waits for its verified host cleanup before the next sample (an
 * orphan profile would skew the next clone). `--purge-early` purges while
 * the profile may still be cloning: the API must wait, never refuse.
 *
 * Without `--purge-early`, the operator then clicks the card's first option
 * the moment the question is complete (a fast operator: the answer may wait
 * for the clone), and that turn is measured from the click.
 */
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import { turnFailure } from "../kit/bots";
import { StepFailed, since, type SampleRow } from "../kit/report";
import type { Scenario } from "../kit/scenario";

export const greeting: Scenario = {
  id: "greeting",
  title: "Bench : création, première question et réponse à la carte",
  summary: "Mesure, par échantillon, le délai entre le clic « Créer » et la première question du bot, puis prouve que chaque bot purgé quitte le runtime.",
  async run({ lab, rec, config, model }) {
    const rows: SampleRow[] = [];
    for (let index = 1; index <= config.samples; index += 1) {
      await rec.step(`Échantillon ${index}`, async () => {
        const t0 = Date.now();
        const bot = await lab.create({
          name: `E2E Accueil ${index}`,
          description: "Assistant de recherche",
          mission: "Préparer des synthèses courtes pour l'équipe.",
          greet: true,
          locale: config.locale,
          // Created on the run's model: the greeting and the answer both use it.
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        });
        const createdMs = Date.now() - t0;
        const runId = await lab.greetingRunId(bot.id);
        const turn = await lab.follow(runId, t0);
        const provisionAtGreeting = await lab.db<{ status: string }[]>`select status from bot_profile_provisions where bot_id = ${bot.id}`;
        const option = splitAskUser(turn.run?.output ?? "").prompt?.options[0] ?? "Commençons.";
        const answer = config.purgeEarly ? null : await lab.send(bot.threadId, option);
        const usage = answer?.marks?.terminalPayload?.usage as { outputTokens?: number } | undefined;
        // The purge erases the provision row: read the clone's end first.
        const provision = config.purgeEarly ? null : await lab.waitProvision(bot.id);
        // --defer-cleanup: the run's purgeAll cleans every bot at the end, in parallel.
        const purge = config.deferCleanup ? null : await lab.purge(bot.id, { waitProvision: false });
        const row: SampleRow = {
          sample: index,
          createdMs,
          runStartedMs: since(t0, turn.run?.startedAt),
          firstTextMs: since(t0, turn.marks?.firstText),
          completeMs: since(t0, turn.marks?.terminal),
          provisionedMs: since(t0, provision?.finishedAt),
          deleteMs: purge?.deleteMs ?? null,
          status: turn.run?.status ?? "timeout",
          profileAtGreeting: provisionAtGreeting[0]?.status ?? null,
          answerStartMs: answer ? since(answer.t0, answer.run?.startedAt) : null,
          answerFirstTextMs: answer ? since(answer.t0, answer.marks?.firstText) : null,
          answerCompleteMs: answer ? since(answer.t0, answer.marks?.terminal) : null,
          answerOutputTokens: usage?.outputTokens ?? null,
          answerToolCalls: answer ? answer.marks?.toolCalls ?? 0 : null,
          cleanup: purge?.cleanup ?? "deferred",
          verifyPasses: purge?.verifyPasses ?? null,
        };
        rows.push(row);
        if (!turn.marks || turn.run?.status !== "completed" || !turn.run.output?.trim()) throw new Error(`The greeting run ended ${String(row.status)} (${turnFailure(turn)}) or empty.`);
        if (answer && answer.marks?.terminalType !== "run.completed") throw new Error(`The card answer failed: ${turnFailure(answer)}.`);
        if (purge && purge.cleanup !== "succeeded") throw new Error(`Host cleanup ended ${purge.cleanup}.`);
        return { completeMs: row.completeMs as number | null, answerCompleteMs: row.answerCompleteMs as number | null, cleanup: purge?.cleanup ?? "deferred" };
      }).catch((error: unknown) => {
        // One failed sample is recorded; the next samples still measure.
        if (!(error instanceof StepFailed)) throw error;
      });
    }
    rec.setBench(
      [
        { key: "sample", label: "#" },
        { key: "createdMs", label: "201 reçu" },
        { key: "runStartedMs", label: "Run démarré" },
        { key: "firstTextMs", label: "Premier texte" },
        { key: "completeMs", label: "Question complète" },
        { key: "provisionedMs", label: "Profil prêt" },
        { key: "deleteMs", label: "DELETE" },
        { key: "profileAtGreeting", label: "Profil à la fin de l'accueil" },
        { key: "answerStartMs", label: "Réponse : run démarré" },
        { key: "answerFirstTextMs", label: "Réponse : premier texte" },
        { key: "answerCompleteMs", label: "Réponse : fin" },
        { key: "answerOutputTokens", label: "Réponse : tokens de sortie" },
        { key: "answerToolCalls", label: "Réponse : appels d'outils" },
        { key: "cleanup", label: "Nettoyage" },
        { key: "verifyPasses", label: "Revérifications" },
      ],
      rows,
      ["createdMs", "runStartedMs", "firstTextMs", "completeMs", "provisionedMs", "answerStartMs", "answerFirstTextMs", "answerCompleteMs", "deleteMs"],
      { keys: [
        { key: "createdMs", label: "201" },
        { key: "runStartedMs", label: "run démarré" },
        { key: "firstTextMs", label: "premier texte" },
        { key: "completeMs", label: "complet" },
      ] },
    );
  },
};
