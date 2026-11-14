/**
 * Bench: the operator's turn on a ready bot. One bot on its own
 * profile receives `--messages` short messages, one at a time, on the SSE
 * stream already open (the PWA case). Content is never asserted: only that
 * a non-empty assistant reply exists.
 */
import { StepFailed, Skip, since, type SampleRow } from "../kit/report";
import type { Scenario } from "../kit/scenario";

const PROMPT = "Réponds seulement : ok.";

export const fastPath: Scenario = {
  id: "fast-path",
  title: "Bench : tour d'un bot prêt",
  summary: "Mesure le 202, le premier événement, le premier texte et la fin de chaque tour sur un bot dont le profil est prêt.",
  async run({ lab, model, rec, config }) {
    let threadId = "";
    let botId = "";
    await rec.step("Bot prêt sur son profil", async () => {
      const bot = await lab.create({ name: "E2E Tour", instructions: "Answer in one short sentence. Never call a tool." });
      botId = bot.id;
      threadId = bot.threadId;
      await lab.setModel(bot, model);
      const provision = await lab.waitProvision(bot.id);
      if (provision.status !== "succeeded" && provision.status !== null) throw new Error(`The profile provision ended ${provision.status}.`);
      return { provision: provision.status, model: model.model };
    });
    const rows: SampleRow[] = [];
    for (let index = 1; index <= config.messages; index += 1) {
      await rec.step(`Message ${index}`, async () => {
        const turn = await lab.send(threadId, PROMPT);
        const row: SampleRow = {
          message: index,
          acceptedMs: turn.acceptedMs,
          queuedMs: turn.run?.startedAt ? turn.run.startedAt.getTime() - turn.run.createdAt.getTime() : null,
          firstEventMs: since(turn.t0, turn.marks?.firstEvent),
          firstTextMs: since(turn.t0, turn.marks?.firstText),
          completeMs: since(turn.t0, turn.marks?.terminal),
          status: turn.run?.status ?? "timeout",
        };
        rows.push(row);
        if (turn.marks?.terminalType !== "run.completed") throw new Error(`Run ${turn.runId} ended ${String(turn.marks?.terminalType ?? "without a terminal event")}.`);
        if (!(await lab.answered(threadId, turn.runId))) throw new Error("No non-empty assistant reply reads back in the thread.");
        return { completeMs: row.completeMs as number | null };
      }).catch((error: unknown) => {
        if (!(error instanceof StepFailed)) throw error;
      });
    }
    rec.setBench(
      [
        { key: "message", label: "#" },
        { key: "acceptedMs", label: "202" },
        { key: "queuedMs", label: "En file (serveur)" },
        { key: "firstEventMs", label: "Premier événement" },
        { key: "firstTextMs", label: "Premier texte" },
        { key: "completeMs", label: "Fin" },
        { key: "status", label: "Statut" },
      ],
      rows,
      ["acceptedMs", "queuedMs", "firstEventMs", "firstTextMs", "completeMs"],
      { keys: [
        { key: "acceptedMs", label: "202" },
        { key: "firstEventMs", label: "premier événement" },
        { key: "firstTextMs", label: "premier texte" },
        { key: "completeMs", label: "fin" },
      ] },
    );
    await rec.step("Purge et nettoyage vérifié", async () => {
      if (config.keep) {
        lab.release(botId);
        throw new Skip("--keep: the bot stays for inspection");
      }
      const purge = await lab.purge(botId);
      if (purge.cleanup !== "succeeded") throw new Error(`Host cleanup ended ${purge.cleanup}.`);
      return { verifyPasses: purge.verifyPasses };
    });
  },
};
