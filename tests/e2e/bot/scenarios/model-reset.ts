/**
 * Bench: « Repasser tous les bots au modèle global ». `--samples` disposable
 * bots get their own model, then the reset is played twice:
 *
 * - the per-bot path (one `PATCH /api/bots/:id` per bot, in series): what
 *   the settings screen did before the grouped reset, kept as the baseline;
 * - the grouped path (`POST /api/bots/model-overrides/reset`): the database
 *   answer, then the host profile alignment it runs in the background,
 *   followed through its job until done.
 *
 * No run, no inference: only roster writes and host profile model writes.
 * The two host reads a PATCH pays are timed alone, to explain its cost.
 *
 * The grouped reset covers the whole organization. It is skipped, never
 * played, while a bot that this run did not create carries its own model:
 * a bench never erases an operator's choice.
 */
import type { BotDto, BotModelResetDto, BotProfileModelSyncDto } from "@openedbot/contracts-api";
import { Skip, warn, type SampleRow } from "../kit/report";
import type { Scenario } from "../kit/scenario";

const SYNC_POLL_MS = 100;

export const modelReset: Scenario = {
  id: "model-reset",
  title: "Bench : repasser tous les bots au modèle global",
  summary: "Compare la remise à zéro bot par bot (un PATCH par bot, en série) à la remise à zéro groupée, réponse API puis alignement des profils hôte suivi jusqu'au bout.",
  async run({ lab, session, rec, config, model }) {
    let bots: BotDto[] = [];
    // An own model equal to the global one leaves every profile already
    // aligned, and the grouped path would measure no host write at all.
    const catalogue = await session.api<{ providers: Array<{ slug: string; authenticated: boolean; models: Array<{ id: string }> }> }>(
      "GET", `/api/runtimes/${session.runtime.id}/models`);
    const global = session.runtime.selectedModel ?? model.model;
    const other = catalogue.providers.find((entry) => entry.slug === model.provider && entry.authenticated)
      ?.models.find((entry) => entry.id !== global)?.id;
    const ownModel = { provider: model.provider, model: other ?? model.model };
    const setOwnModels = async () => {
      for (const bot of bots) await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, ownModel);
    };
    const rows: SampleRow[] = [];

    await rec.step(`${config.samples} bots jetables avec un modèle propre`, async () => {
      bots = await Promise.all(Array.from({ length: config.samples }, (_, index) =>
        lab.create({ name: `E2E Reset ${index + 1}`, ...ownModel })));
      const provisions = await Promise.all(bots.map((bot) => lab.waitProvision(bot.id)));
      const failed = provisions.filter((entry) => entry.status !== "succeeded" && entry.status !== null);
      if (failed.length) throw new Error(`${failed.length} profile provision(s) ended ${failed.map((entry) => entry.status).join(", ")}.`);
      if (!other) return warn(`No second model on ${model.provider}: the own model equals the global one, so the grouped path measures no host write.`, { bots: bots.length, ownModel: ownModel.model, global });
      return { bots: bots.length, ownModel: ownModel.model, global };
    });

    await rec.step("Coût d'une lecture hôte (catalogue, inventaire des profils)", async () => {
      const time = async (path: string) => {
        const started = performance.now();
        await session.api("GET", path);
        return Math.round(performance.now() - started);
      };
      return {
        catalogMs: await time(`/api/runtimes/${session.runtime.id}/models?fresh=1`),
        inventoryMs: await time("/api/runtime/profiles?fresh=1"),
      };
    });

    await rec.step("Avant : un PATCH par bot, en série", async () => {
      const started = performance.now();
      for (const [index, bot] of bots.entries()) {
        const t0 = performance.now();
        const patched = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { model: null, reasoningEffort: null });
        if (patched.model !== null) throw new Error(`Bot ${index + 1} still reads back model ${patched.model}.`);
        rows.push({ path: `avant · bot ${index + 1}`, bots: 1, ackMs: Math.round(performance.now() - t0), syncedMs: null, aligned: null, failed: null });
      }
      const totalMs = Math.round(performance.now() - started);
      rows.push({ path: "avant · total", bots: bots.length, ackMs: totalMs, syncedMs: totalMs, aligned: null, failed: null });
      return { totalMs, perBotMs: Math.round(totalMs / bots.length) };
    });

    await rec.step("Modèles propres reposés", async () => {
      await setOwnModels();
      return { bots: bots.length };
    });

    await rec.step("Après : remise à zéro groupée, puis alignement des profils", async () => {
      const before = await session.api<{ bots: BotDto[] }>("GET", "/api/bots?includeHidden=true");
      const foreign = before.bots.filter((bot) => !bots.some((own) => own.id === bot.id)
        && bot.archivedAt === null && (bot.model !== null || bot.reasoningEffort !== null));
      if (foreign.length) {
        throw new Skip(`${foreign.length} bot(s) not created by this run carry their own model (${foreign.map((bot) => bot.name).join(", ")}): the organization-wide reset would erase it.`);
      }
      const t0 = performance.now();
      const response = await session.raw("POST", "/api/bots/model-overrides/reset");
      if (response.status === 404) throw new Skip("POST /api/bots/model-overrides/reset is not served by this API.");
      if (response.status !== 202) throw new Error(`The grouped reset answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const reset = (await response.json()) as BotModelResetDto;
      const ackMs = Math.round(performance.now() - t0);
      const roster = await session.api<{ bots: BotDto[] }>("GET", "/api/bots?includeHidden=true");
      const left = roster.bots.filter((bot) => bots.some((own) => own.id === bot.id) && (bot.model !== null || bot.reasoningEffort !== null));
      if (left.length) throw new Error(`${left.length} bot(s) still carry their own model after the grouped reset.`);
      let sync: BotProfileModelSyncDto | null = reset.sync;
      let progressTicks = 0;
      while (sync?.status === "running") {
        if (performance.now() - t0 > config.cleanupTimeoutMs) throw new Error("The profile alignment did not finish in time.");
        await Bun.sleep(SYNC_POLL_MS);
        sync = (await session.api<{ sync: BotProfileModelSyncDto | null }>("GET", "/api/bots/model-overrides/sync")).sync;
        progressTicks += 1;
      }
      const syncedMs = Math.round(performance.now() - t0);
      rows.push({ path: "après · groupé", bots: reset.cleared, ackMs, syncedMs, aligned: sync?.aligned ?? null, failed: sync?.failed ?? null });
      if (reset.cleared !== bots.length) throw new Error(`The grouped reset cleared ${reset.cleared} bot(s), expected ${bots.length}.`);
      return { cleared: reset.cleared, ackMs, syncedMs, total: sync?.total ?? 0, aligned: sync?.aligned ?? 0, failed: sync?.failed ?? 0, progressTicks };
    });

    rec.setBench(
      [
        { key: "path", label: "Chemin" },
        { key: "bots", label: "Bots" },
        { key: "ackMs", label: "Réponse API (bots remis au global en base)" },
        { key: "syncedMs", label: "Profils hôte alignés" },
        { key: "aligned", label: "Profils alignés" },
        { key: "failed", label: "Échecs hôte" },
      ],
      rows,
      [],
    );
  },
};
