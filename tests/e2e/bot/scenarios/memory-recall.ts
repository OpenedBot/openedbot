import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import type { Scenario } from "../kit/scenario";
import { capabilities, completed, deleteGroup, invariant, matchingToolResult, ownGroup, readyBot, restartIdleGateway, toolEvents, toolset } from "../kit/p1-evidence";

type Memory = { available: boolean; enabled?: boolean; profile?: string; entries?: { memory: string[] } };

export const memoryRecall: Scenario = {
  id: "memory-recall",
  title: "Mémoire apprise, retrouvée après redémarrage",
  summary: "Le bot écrit lui-même un fait, le retrouve dans une nouvelle session après redémarrage, et un second profil ne le connaît pas.",
  async run(context) {
    const { session, lab, rec } = context;
    const fact = `MEMORY_${crypto.randomUUID().replaceAll("-", "")}`;
    const subject = `project-${lab.tag}`;
    let primary!: BotDto;
    let control!: BotDto;
    let group: GroupDto | undefined;
    let learningSessionKey = "";
    try {
      await rec.step("Deux profils isolés et mémoire disponible", async () => {
        invariant(session.hasFeature("profile_memory"), "The runtime does not advertise profile_memory.");
        primary = await readyBot(context, "E2E Memory owner");
        control = await readyBot(context, "E2E Memory control");
        invariant(primary.hermesProfile !== control.hermesProfile, "The bots share a profile.");
        await toolset(session, primary, "memory", true);
        const inventory = await capabilities(session, primary);
        invariant(inventory.toolsets?.some((entry) => entry.name === "memory" && entry.enabled), "Memory is not active on the owned profile.");
      });
      await rec.step("Apprentissage par l'outil puis lecture indépendante", async () => {
        const turn = await lab.send(primary.threadId, `Remember this permanently using your memory tool: the release code for ${subject} is ${fact}. Do not just acknowledge it: persist it in MEMORY.md. Then reply SAVED.`);
        completed(turn, "SAVED");
        invariant(turn.run?.executionSessionKey, "The learning run has no execution session identity.");
        learningSessionKey = turn.run.executionSessionKey;
        matchingToolResult(await toolEvents(context, turn.runId), "memory");
        const stored = await session.api<Memory>("GET", `/api/bots/${primary.id}/runtime-memory`);
        invariant(stored.available && stored.profile === primary.hermesProfile && stored.entries?.memory.some((entry) => entry.includes(fact)), "The learned fact is absent from the owner's persisted profile memory.");
        const other = await session.api<Memory>("GET", `/api/bots/${control.id}/runtime-memory`);
        invariant(other.available && !other.entries?.memory.some((entry) => entry.includes(fact)), "The learned fact leaked into the control profile memory.");
        return { runId: turn.runId, persisted: true };
      });
      await rec.step("Redémarrage réel sans travail étranger", async () => {
        await restartIdleGateway(context, [primary.id, control.id]);
      });
      await rec.step("Le profil témoin ne connaît pas le fait", async () => {
        const turn = await lab.send(control.threadId, `What is the release code for ${subject}? Use only your own saved memory. If it is not there reply exactly UNKNOWN, never guess. Do not search other sessions or profiles.`);
        completed(turn, "UNKNOWN");
        return { runId: turn.runId };
      });
      await rec.step("Nouvelle session, rappel exact sans fournir la valeur", async () => {
        group = await ownGroup(session, `E2E Recall ${lab.tag}`, [primary, control]);
        const turn = await lab.send(group.threadId, `@${primary.slug} What is the release code for ${subject} in your saved memory? Reply with only the exact code.`);
        completed(turn, fact);
        invariant(turn.run?.executionSessionKey, "The recall has no execution session identity.");
        invariant(turn.run.executionSessionKey !== learningSessionKey, "The recall reused the learning session instead of reading durable profile memory.");
        const rows = await lab.db<Array<{ count: number }>>`select count(*)::int as count from runs where organization_id = ${session.organizationId}
          and bot_id = ${primary.id} and thread_id = ${group.threadId} and id <> ${turn.runId}`;
        invariant(rows[0]?.count === 0, "The recall session already contains another run.");
        return { runId: turn.runId, newThread: true, survivedRestart: true };
      });
    } finally {
      if (group) await deleteGroup(session, group.id);
    }
  },
};
