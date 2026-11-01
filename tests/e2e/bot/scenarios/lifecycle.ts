/**
 * One bot from creation to purge, every feature an operator touches, each
 * write proven by a re-read. A feature the host does not announce is
 * recorded as skipped with its reason, never assumed.
 */
import type { BotDto } from "@openedbot/contracts-api";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import { Skip, since, warn } from "../kit/report";
import type { Scenario } from "../kit/scenario";

type RuntimeMemory =
  | { available: false; reason: string }
  | { available: true; profile: string; enabled: boolean; limits: { memory: number }; entries: { memory: string[] }; usedChars: { memory: number } };
type LinkEvent = { id: string; kind: string; occurredAt: string };
const LINK_INCIDENTS = new Set(["connected", "disconnected", "replaced", "revoked", "hijack_suspected"]);

export const lifecycle: Scenario = {
  id: "lifecycle",
  title: "Cycle de vie d'un bot",
  summary: "Un bot créé avec l'accueil pose sa première question, répond sur son propre profil, garde ses réglages relus, puis disparaît du runtime une fois purgé.",
  async run({ lab, session, model, rec, config }) {
    const { runtime } = session;
    const connector = runtime.reachability === "connector";
    const linkEventsPath = `/api/runtime/${runtime.id}/link/events?limit=200`;
    let boundary: LinkEvent | undefined;
    let bot!: BotDto;
    let greetingOutput = "";
    let createdT0 = 0;

    await rec.step("Runtime lié", async () => {
      if (connector) boundary = (await session.api<{ events: LinkEvent[] }>("GET", linkEventsPath)).events[0];
      return { runtime: runtime.name, reachability: runtime.reachability, provider: model.provider, model: model.model, features: (runtime.linkFeatures ?? []).length };
    });

    await rec.step("Création avec accueil", async () => {
      createdT0 = Date.now();
      bot = await lab.create({
        name: "E2E Atlas",
        description: "Assistant de recherche",
        mission: "Préparer des synthèses courtes pour l'équipe.",
        greet: true,
        locale: config.locale,
      });
      const createdMs = Date.now() - createdT0;
      if (session.hasFeature("profile_management")) {
        if (bot.hermesProfile !== bot.slug || bot.hermesProfileManaged !== true) throw new Error(`The bot does not carry its managed profile (read ${String(bot.hermesProfile)}).`);
      }
      return { createdMs, slug: bot.slug, profile: bot.hermesProfile };
    });

    await rec.step("Première question (accueil)", async () => {
      const runId = await lab.greetingRunId(bot.id);
      const turn = await lab.follow(runId, createdT0);
      if (!turn.marks) throw new Error(`The greeting run ${runId} never ended within ${config.runTimeoutMs} ms.`);
      if (turn.run?.status !== "completed") throw new Error(`The greeting run ended ${String(turn.run?.status)}.`);
      greetingOutput = turn.run.output ?? "";
      if (!greetingOutput.trim()) throw new Error("The greeting run completed with an empty output.");
      const detail = {
        runStartedMs: since(turn.t0, turn.run.startedAt),
        firstTextMs: since(turn.t0, turn.marks.firstText),
        completeMs: since(turn.t0, turn.marks.terminal),
        onDefaultProfile: turn.run.executionSessionKey?.endsWith(":greeting") ?? false,
      };
      const card = splitAskUser(greetingOutput).prompt;
      if (!card) return warn("The model did not end its greeting with an ask_user card.", detail);
      return { ...detail, options: card.options.length };
    });

    await rec.step("Profil du bot prêt", async () => {
      if (!session.hasFeature("profile_management")) throw new Skip("host without profile_management");
      const provision = await lab.waitProvision(bot.id);
      if (provision.status !== "succeeded" && provision.status !== null) throw new Error(`The profile provision ended ${provision.status}.`);
      return { provision: provision.status, readyMs: since(createdT0, provision.finishedAt) };
    });

    await rec.step("Apparence", async () => {
      const face = { shape: "hexagone", palette: "turquoise", eyes: "attentif" };
      const patched = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { face });
      if (patched.face?.shape !== face.shape || patched.face?.palette !== face.palette || patched.face?.eyes !== face.eyes) {
        throw new Error("The face does not read back as written.");
      }
      return face;
    });

    await rec.step("Modèle du bot", async () => {
      await lab.setModel(bot, model);
      if (!session.hasFeature("profile_capabilities") || !bot.hermesProfile) return { model: model.model, profileReadback: false };
      const inventory = await session.api<{ profiles: Array<{ name: string; model: { provider: string | null; default: string | null } }> }>("GET", "/api/runtime/profiles?fresh=1");
      const profile = inventory.profiles.find((entry) => entry.name === bot.hermesProfile);
      if (profile?.model.provider !== model.provider || profile.model.default !== model.model) {
        throw new Error(`The host profile reads ${String(profile?.model.provider)}/${String(profile?.model.default)}.`);
      }
      return { model: model.model, profileReadback: true };
    });

    await rec.step("Mémoire du runtime", async () => {
      const first = await session.api<RuntimeMemory>("GET", `/api/bots/${bot.id}/runtime-memory`);
      if (!first.available) throw new Skip(`memory unavailable: ${first.reason}`);
      if (!first.enabled) {
        const on = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/toolsets/memory`, { enabled: true });
        if (!on.enabled || !on.applied) throw new Error("The host did not confirm the memory toolset.");
      }
      const fact = `Le domaine de travail est atlas-${lab.tag}.example.`;
      await session.api("POST", `/api/bots/${bot.id}/runtime-memory`, { target: "memory", action: "add", content: fact });
      const reread = await session.api<RuntimeMemory>("GET", `/api/bots/${bot.id}/runtime-memory`);
      if (!reread.available || !reread.entries.memory.some((entry) => entry.includes(fact))) throw new Error("The fact does not read back from MEMORY.md.");
      if (reread.usedChars.memory > reread.limits.memory) throw new Error("The memory store exceeds its own limit.");
      return { chars: reread.usedChars.memory, enabled: reread.enabled };
    });

    await rec.step("Capacités (toolset web)", async () => {
      if (!session.hasFeature("profile_management") || !session.hasFeature("profile_capabilities")) throw new Skip("host without profile capabilities");
      const scope = await session.api<{ botId: string; scope: string }>("GET", `/api/bots/${bot.id}/capabilities`);
      if (scope.scope !== "profile") throw new Error(`Capabilities have scope ${scope.scope}, not profile.`);
      for (const enabled of [false, true]) {
        const result = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/toolsets/web`, { enabled });
        if (result.enabled !== enabled || !result.applied) throw new Error(`The web toolset ${enabled ? "on" : "off"} was not applied.`);
      }
      return { scope: scope.scope };
    });

    await rec.step("Réponse à la carte, sur le profil du bot", async () => {
      const option = splitAskUser(greetingOutput).prompt?.options[0] ?? "Commençons.";
      const turn = await lab.send(bot.threadId, option);
      if (!turn.marks) throw new Error(`Run ${turn.runId} never ended within ${config.runTimeoutMs} ms.`);
      if (turn.marks.terminalType !== "run.completed") throw new Error(`The run ended ${String(turn.marks.terminalType)}.`);
      const completion = turn.marks.terminalPayload?.completion as { version?: number; run?: { id?: string } } | undefined;
      if (completion?.version !== 1 || completion.run?.id !== turn.runId) throw new Error("The terminal event carries no completion block for this run.");
      if (!(await lab.answered(bot.threadId, turn.runId))) throw new Error("No non-empty assistant reply reads back in the thread.");
      if (turn.run?.executionSessionKey?.endsWith(":greeting")) throw new Error("The follow-up turn ran on the greeting session.");
      return {
        acceptedMs: turn.acceptedMs,
        firstTextMs: since(turn.t0, turn.marks.firstText),
        completeMs: since(turn.t0, turn.marks.terminal),
      };
    });

    await rec.step("Modèle global affiché", async () => {
      const global = runtime.selectedModel ?? null;
      const relayed = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { model: null });
      if (relayed.model !== null) throw new Error("The bot could not go back to the global model.");
      const thread = await session.api<{ effectiveModel: string | null }>("GET", `/api/threads/${bot.threadId}`);
      await lab.setModel(bot, model);
      if (!global) throw new Skip("no global model preference: Hermes decides");
      if (thread.effectiveModel !== global) throw new Error(`The thread announces ${String(thread.effectiveModel)}, the preference is ${global}.`);
      return { global };
    });

    await rec.step("Limites fournisseur actualisées", async () => {
      if (!session.hasFeature("provider_usage")) throw new Skip("host without provider_usage");
      const asked = Date.now();
      const usage = await session.api<{ status: string; fetchedAt: string | null; providers: Array<{ provider: string }> }>("GET", `/api/runtimes/${runtime.id}/provider-usage?refresh=1`);
      if (usage.status === "stale") throw new Error("Refresh returned the old reading as stale instead of waiting for the probe.");
      if (usage.status !== "ok") return warn(`provider usage unreadable: ${usage.status}`);
      const lag = asked - Date.parse(usage.fetchedAt ?? "");
      if (!(lag < 90_000)) throw new Error(`The refreshed reading is ${Math.round(lag / 1000)} s old.`);
      return { providers: usage.providers.length, lagS: Math.round(lag / 1000) };
    });

    await rec.step("Présent au roster", async () => {
      const { bots } = await session.api<{ bots: BotDto[] }>("GET", "/api/bots");
      const listed = bots.find((entry) => entry.id === bot.id);
      if (!listed || listed.name !== bot.name || listed.model !== model.model || !listed.face) throw new Error("The roster does not show the bot with its name, model and face.");
    });

    if (config.keep) {
      lab.release(bot.id);
      await rec.step("Bot conservé (--keep)", async () => warn("Archive and purge not played: the bot stays for inspection.", { botId: bot.id, url: `http://localhost:1420/bot/${bot.id}` }));
      return;
    }

    await rec.step("Archivé puis restauré", async () => {
      const archived = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { archived: true });
      if (!archived.archivedAt) throw new Error("Archiving did not stamp the bot.");
      const { bots } = await session.api<{ bots: BotDto[] }>("GET", "/api/bots");
      if (!bots.find((entry) => entry.id === bot.id)?.archivedAt) throw new Error("The roster does not carry archivedAt.");
      const restored = await session.api<BotDto>("PATCH", `/api/bots/${bot.id}`, { archived: false });
      if (restored.archivedAt || restored.deletedAt) throw new Error("Restoring did not clear archive and trash.");
    });

    await rec.step("Corbeille, purge et nettoyage vérifié", async () => {
      const trash = await session.raw("DELETE", `/api/bots/${bot.id}`);
      if (!trash.ok) throw new Error(`Trash refused (HTTP ${trash.status}).`);
      const purge = await lab.purge(bot.id, { waitProvision: false });
      if (purge.cleanup !== "succeeded") throw new Error(`Host cleanup ended ${purge.cleanup}.`);
      const gone = await session.raw("GET", `/api/bots/${bot.id}/runtime-memory`);
      if (gone.status !== 404) throw new Error(`A purged bot answers ${gone.status}, not 404.`);
      return { cleanup: purge.cleanup, verifyPasses: purge.verifyPasses, cleanupS: Math.round(purge.durationMs / 1000) };
    });

    await rec.step("Lien stable pendant le parcours", async () => {
      if (!connector || !boundary) throw new Skip("not a connector runtime");
      const { events } = await session.api<{ events: LinkEvent[] }>("GET", linkEventsPath);
      if (!events.some((event) => event.id === boundary!.id)) throw new Error("The link journal boundary fell out of the 200 newest events.");
      const since = Date.parse(boundary.occurredAt);
      const incidents = events.filter((event) => event.id !== boundary!.id && Date.parse(event.occurredAt) >= since && LINK_INCIDENTS.has(event.kind));
      if (incidents.length) throw new Error(`The link changed during the run: ${incidents.map((event) => event.kind).join(", ")}.`);
      return { incidents: 0 };
    });
  },
};
