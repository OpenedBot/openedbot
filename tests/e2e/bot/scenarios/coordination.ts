/**
 * Named coordination A/B/A: a coordinator delegates once to a named
 * reviewer, the platform resumes the coordinator, all in the coordinator's
 * thread; the specialists' own threads stay empty.
 */
import type { BotDto } from "@openedbot/contracts-api";
import { hasNonEmptyAssistantText } from "../../../../scripts/lib/fast-path-measurements";
import type { Scenario } from "../kit/scenario";

type Run = { id: string; botId: string | null; workflowId: string | null; stepKind: string | null; status: string; endedAt: string | null };
type Snapshot = {
  runs: Run[];
  events: Array<{ runId: string; type: string; payload: Record<string, unknown> }>;
  messages: Array<{ role: string; runId: string | null; content: unknown }>;
};

export const coordination: Scenario = {
  id: "coordination",
  title: "Coordination nommée A/B/A",
  summary: "Un coordinateur délègue une fois à un relecteur nommé, reprend la main et conclut, sans rien exécuter dans le fil des spécialistes.",
  async run({ lab, session, model, rec, config }) {
    const bots: BotDto[] = [];

    await rec.step("Trois bots sans outils", async () => {
      for (const role of ["Coordinator", "Reviewer", "Researcher"]) {
        const bot = await lab.create({
          name: `E2E ${role}`,
          instructions: "Do the requested work in one short final reply. Never call a tool, never delegate or promise a later answer.",
        });
        bots.push(bot);
        await lab.waitProvision(bot.id);
        const patched = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
          autonomy: { enabled: role === "Coordinator" },
        });
        if (patched.model !== model.model || patched.autonomy?.enabled !== (role === "Coordinator")) throw new Error("Model or autonomy does not read back.");
        const capabilities = await session.api<{ toolsets?: Array<{ name: string; enabled: boolean }> }>("GET", `/api/bots/${bot.id}/capabilities`);
        for (const toolset of capabilities.toolsets ?? []) {
          if (!toolset.enabled) continue;
          const off = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/toolsets/${encodeURIComponent(toolset.name)}`, { enabled: false });
          if (!off.applied || off.enabled) throw new Error(`Toolset ${toolset.name} was not disabled.`);
        }
      }
      return { bots: bots.length };
    });

    const [a, b, c] = bots as [BotDto, BotDto, BotDto];
    let workflowId = "";
    let snapshot: Snapshot | null = null;

    await rec.step("Délégation puis reprise", async () => {
      await session.api("PATCH", `/api/bots/${a.id}`, {
        instructions: `You are the coordinator of this disposable acceptance test. For a NEW request, write one short useful partial sentence, then delegate exactly once to @${b.slug} by ending your reply with exactly this single last line: @${b.slug} Check the sum of 2 and 2 and give a short final result without tools. When the platform returns the reviewer's result and asks you to resume, give one short final synthesis and never delegate again. No other bot may be mentioned. Never use tools.`,
      });
      const t0 = Date.now();
      const admission = await session.api<{ runId: string; workflowId: string | null }>("POST", `/api/threads/${a.threadId}/messages`, {
        input: "Vérifie la somme de 2 et 2 avec ton relecteur, puis donne ta synthèse en une phrase courte.",
      }, 202);
      if (!admission.workflowId) throw new Error("The root run has no opted-in workflow.");
      workflowId = admission.workflowId;
      const deadline = Date.now() + config.runTimeoutMs;
      while (Date.now() < deadline) {
        const state = await session.api<{ status: string }>("GET", `/api/workflows/${workflowId}`);
        if (["failed", "expired", "cancelled", "unknown"].includes(state.status)) throw new Error(`The workflow ended ${state.status}.`);
        if (state.status === "completed") {
          snapshot = await session.api<Snapshot>("GET", `/api/threads/${a.threadId}`);
          break;
        }
        await Bun.sleep(300);
      }
      if (!snapshot) throw new Error(`The workflow did not complete within ${config.runTimeoutMs} ms.`);
      return { workflowMs: Date.now() - t0 };
    });

    await rec.step("Chaîne A/B/A et accusés dans le fil", async () => {
      const chain = snapshot!.runs.filter((run) => run.workflowId === workflowId);
      const root = chain.find((run) => run.stepKind === "root");
      const child = chain.find((run) => run.stepKind === "delegated");
      const resumed = chain.find((run) => run.stepKind === "continuation");
      if (chain.length !== 3 || root?.botId !== a.id || child?.botId !== b.id || resumed?.botId !== a.id) throw new Error("No exact A/B/A chain was executed.");
      const receipts = snapshot!.events.filter((event) => event.type === "system.notice"
        && (event.payload.childRunId === child.id || event.payload.continuationRunId === resumed.id));
      if (receipts.length !== 2) throw new Error(`Expected 2 receipts in the thread, found ${receipts.length}.`);
      for (const run of chain) {
        const replied = snapshot!.messages.some((message) => message.runId === run.id && message.role === "assistant" && hasNonEmptyAssistantText(message.content));
        if (run.status !== "completed" || !replied) throw new Error(`Step ${String(run.stepKind)} has no completed, non-empty reply.`);
      }
      return { steps: chain.length, handoffs: 1, receipts: receipts.length };
    });

    await rec.step("Fils des spécialistes vides", async () => {
      const others = await Promise.all([b, c].map((bot) => session.api<Snapshot>("GET", `/api/threads/${bot.threadId}`)));
      if (others.some((other) => other.runs.length > 0)) throw new Error("Coordination ran in a specialist's own thread.");
    });

    await rec.step("Purge et nettoyage vérifié", async () => {
      // In parallel: each cleanup waits a minute for its re-check pass.
      const outcomes = await Promise.all(bots.map((bot) => lab.purge(bot.id)));
      const failed = outcomes.filter((outcome) => outcome.cleanup !== "succeeded");
      if (failed.length) throw new Error(`Host cleanup failed for ${failed.map((outcome) => `${outcome.name}: ${outcome.cleanup}`).join(", ")}.`);
      return { purged: outcomes.length };
    });
  },
};
