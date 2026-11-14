import type { BotDto, GroupDto, RuntimeIntegrationMcpServerDto } from "@openedbot/contracts-api";
import type { Scenario } from "../kit/scenario";
import { McpFixture, mcpProbeToolName } from "../kit/p1-mcp-fixture";
import { ApiError } from "../kit/session";
import { capabilities, completed, deleteGroup, invariant, matchingToolResult, noTools, ownGroup, poll, readyBot, toolEvents, toolset } from "../kit/p1-evidence";
import { labMcpScenario } from "../kit/lab-mcp-scenario";
import { sendFixtureOnce, sendFixtureWithoutApproval } from "../kit/fixture-once";

export const skillsMcp: Scenario = {
  id: "skills-mcp",
  title: "Skill installée et MCP réellement utilisé",
  summary: "Une skill créée sur un profil est relue par outil ; un MCP contrôlé retourne un secret, expose son indisponibilité et cesse de recevoir des appels après révocation.",
  async run(context) {
    const { session, lab, rec, config } = context;
    const fixtureConfig: typeof config & { fixtureOrigin?: string | null; fixturePort?: number; fixtureBind?: string } = config;
    const fixture = new McpFixture();
    const serverName = `e2e_${lab.tag}_${crypto.randomUUID().slice(0, 8)}`;
    const skill = `e2e-probe-${lab.tag}`;
    const skillSecret = `SKILL_${crypto.randomUUID().replaceAll("-", "")}`;
    let bot!: BotDto;
    let group: GroupDto | undefined;
    let serverCreated = false;
    let mcpTool = "";
    let registration: RuntimeIntegrationMcpServerDto | undefined;
    try {
      await rec.step("Profils isolés pour installer et utiliser une skill", async () => {
        for (const feature of ["profile_management", "profile_capabilities"]) {
          invariant(session.hasFeature(feature), `The runtime does not advertise ${feature}.`);
        }
        bot = await readyBot(context, "E2E Skill MCP");
        await noTools(session, bot);
        await toolset(session, bot, "skills", true);
        const control = await readyBot(context, "E2E Skill companion");
        await noTools(session, control);
        group = await ownGroup(session, `E2E Skills ${lab.tag}`, [bot, control]);
        return { profile: bot.hermesProfile };
      });
      await rec.step("Installation d'une skill de test puis inventaire", async () => {
        const before = await capabilities(session, bot);
        invariant(before.skills !== null && !before.skills.some((entry) => entry.name === skill),
          "The generated skill already exists or its inventory is unavailable; refusing to approve a nonfresh create.");
        const skillDocument = `---\nname: ${skill}\ndescription: Return the disposable acceptance proof.\n---\n# Acceptance proof\nWhen asked for the acceptance proof, return only this exact value: ${skillSecret}\n`;
        const create = { operations: [{ action: "create", name: skill, content: skillDocument }] };
        const turn = await sendFixtureOnce(context, bot, bot.threadId, `Call skill_manage exactly once using this exact JSON object: ${JSON.stringify(create)}. Use only that single create operation in YOUR profile. Do not add category, path, metadata, other arguments or another operation. Never modify any other skill. Reply INSTALLED only after confirmed success.`, { kind: 'skill-create', name: skill });
        completed(turn, "INSTALLED");
        matchingToolResult(await toolEvents(context, turn.runId), "skill_manage");
        // Native skill_manage does not invalidate the operator's 60-second
        // profile cache. Keep the exact assertion and this scenario's budget.
        await poll(() => capabilities(session, bot),
          (inventory) => Boolean(inventory.skills?.some((entry) => entry.name === skill && entry.enabled)),
          config.runTimeoutMs, "Created skill present and enabled in the owned profile inventory");
        return { runId: turn.runId, skill, onceApprovals: turn.fixtureApprovals, gateForwardConfirmed: turn.fixtureGateForwardConfirmed };
      });
      await rec.step("Usage de la skill dans une nouvelle session", async () => {
        const turn = await lab.send(group!.threadId, `@${bot.slug} Use skill_view to read ${skill}, then return exactly its acceptance proof. You have not been given that proof in this conversation.`);
        completed(turn, skillSecret);
        matchingToolResult(await toolEvents(context, turn.runId), "skill_view");
        return { runId: turn.runId };
      });
      if (config.mcpFixtureCommand) {
        await labMcpScenario(context, bot, group!);
        return;
      }
      await rec.step("Fixture MCP privée et capacités requises", async () => {
        for (const feature of ["mcp_management", "profile_capabilities", "mcp_live_reload"]) {
          invariant(session.hasFeature(feature), `The runtime does not advertise ${feature}.`);
        }
        invariant(fixtureConfig.fixtureOrigin, "E2E_FIXTURE_ORIGIN must expose the owned MCP fixture to the runtime over trusted HTTPS.");
        const url = fixture.url(fixtureConfig.fixtureOrigin);
        fixture.start(fixtureConfig.fixturePort ?? 18871, fixtureConfig.fixtureBind ?? "127.0.0.1");
        const root = await session.api<{ servers: Array<{ name: string }> }>("GET", "/api/runtime/integrations/mcp?fresh=1");
        invariant(!root.servers.some((entry) => entry.name === serverName), "The generated MCP name already exists; refusing replacement.");
        let added: RuntimeIntegrationMcpServerDto;
        try {
          added = await session.api<RuntimeIntegrationMcpServerDto>("POST", "/api/runtime/integrations/mcp/servers", { name: serverName, url, auth: "none" });
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
          throw new Error(`MCP registration for ${serverName} has an unconfirmed outcome. No removal will be attempted; reconcile this exact generated server name before retrying.`, { cause: error });
        }
        invariant(added.name === serverName, "MCP registration returned a different server name; ownership is unproven and cleanup is refused.");
        serverCreated = true;
        registration = added;
        invariant(!added.unreachable && added.discoveredTools?.includes("read_probe"), "The runtime could not discover the controlled MCP read_probe tool.");
        mcpTool = mcpProbeToolName(serverName);
        return { server: serverName };
      });
      await rec.step("MCP activé sur le profil et appel réel", async () => {
        const on = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/mcp/${serverName}`, { enabled: true });
        invariant(on.enabled && on.applied, "The test MCP was not enabled on the owned profile.");
        await poll(() => capabilities(session, bot), (value) => Boolean(value.mcpServers?.some((entry) => entry.name === serverName && entry.enabled)), config.runTimeoutMs, "Profile MCP activation");
        const challenge = crypto.randomUUID();
        const turn = await sendFixtureOnce(context, bot, group!.threadId, `@${bot.slug} Call ${mcpTool} with challenge ${challenge}. Return only the exact secret returned by that call. Do not use any other tool.`,
          { kind: 'https-mcp-read', serverName, registration: registration!, fixture, origin: fixtureConfig.fixtureOrigin!, challenge });
        completed(turn, fixture.secret);
        matchingToolResult(await toolEvents(context, turn.runId), mcpTool);
        invariant(fixture.calls.some((call) => call.challenge === challenge && call.succeeded), "The controlled server received no successful call with this turn's challenge.");
        return { runId: turn.runId, serverObserved: true, onceApprovals: turn.fixtureApprovals, gateForwardConfirmed: turn.fixtureGateForwardConfirmed };
      });
      await rec.step("Indisponibilité visible, sans secret inventé", async () => {
        fixture.online = false;
        const challenge = crypto.randomUUID();
        const turn = await sendFixtureOnce(context, bot, group!.threadId, `@${bot.slug} Call ${mcpTool} with challenge ${challenge} now. If the tool fails return exactly UNAVAILABLE. A prior secret is not a valid response.`,
          { kind: 'https-mcp-read', serverName, registration: registration!, fixture, origin: fixtureConfig.fixtureOrigin!, challenge });
        completed(turn, "UNAVAILABLE");
        matchingToolResult(await toolEvents(context, turn.runId), mcpTool, true);
        invariant(fixture.calls.some((call) => call.challenge === challenge && !call.succeeded), "The unavailable fixture was not actually called for this turn.");
        return { runId: turn.runId, errorObserved: true, onceApprovals: turn.fixtureApprovals, gateForwardConfirmed: turn.fixtureGateForwardConfirmed };
      });
      await rec.step("Révocation effective au tour suivant", async () => {
        fixture.online = true;
        const off = await session.api<{ enabled: boolean; applied: boolean }>("POST", `/api/bots/${bot.id}/capabilities/mcp/${serverName}`, { enabled: false });
        invariant(off.applied && !off.enabled, "The owned profile MCP was not disabled.");
        const inventory = await capabilities(session, bot);
        invariant(inventory.mcpServers?.find((entry) => entry.name === serverName)?.enabled === false, "The MCP revocation did not read back.");
        const before = fixture.calls.length;
        const turn = await sendFixtureWithoutApproval(context, bot, group!.threadId, `@${bot.slug} If ${mcpTool} is available call it with challenge ${crypto.randomUUID()}; otherwise reply exactly REVOKED. Never use a previous result.`);
        completed(turn, "REVOKED");
        invariant(fixture.calls.length === before, "The server still received a call after revocation.");
        invariant(!(await toolEvents(context, turn.runId)).some((event) => event.type === "tool.call" && event.payload.tool === mcpTool), "A revoked tool was still advertised and called.");
        return { runId: turn.runId, callsAfterRevocation: 0 };
      });
    } finally {
      // The root server is uniquely owned; never replace/remove an operator's entry.
      try { if (group) await deleteGroup(session, group.id); }
      finally {
        try {
          if (serverCreated) {
            const inventory = await session.api<{ servers: Array<{ name: string }> }>("GET", "/api/runtime/integrations/mcp?fresh=1");
            const existing = inventory.servers.find((entry) => entry.name === serverName);
            if (existing) {
              await session.api("DELETE", `/api/runtime/integrations/mcp/servers/${serverName}`, undefined, 204);
            }
          }
        }
        finally { fixture.stop(); }
      }
    }
  },
};
