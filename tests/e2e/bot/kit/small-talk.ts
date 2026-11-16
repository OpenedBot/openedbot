import type { BotDto } from "@openedbot/contracts-api";
import type { ScenarioContext } from "./scenario";
import { capabilities, completed, invariant, toolEvents } from "./p1-evidence";
import { sendFixtureWithoutApproval } from "./fixture-once";

/** Call only after a paired tool_search/tool_describe and native fixture call. */
export async function smallTalkWithDiscovery(context: ScenarioContext, bot: BotDto, serverName: string, threadId: string, input: string): Promise<string> {
  const inventory = await capabilities(context.session, bot);
  invariant(inventory.toolsets?.some((set) => set.name === "skills" && set.enabled && set.tools.includes("skill_view")),
    "Small-talk acceptance requires enabled skills, not an empty tool profile.");
  invariant(inventory.mcpServers?.some((server) => server.name === serverName && server.enabled),
    "The controlled third-party MCP must stay enabled during small talk.");
  // No instruction about tools is added to the user's greeting.
  const turn = await sendFixtureWithoutApproval(context, bot, threadId, input);
  completed(turn);
  invariant(!(await toolEvents(context, turn.runId)).some((event) => event.type === "tool.call"),
    "Small talk called a tool while skills and MCP discovery were available.");
  return turn.runId;
}
