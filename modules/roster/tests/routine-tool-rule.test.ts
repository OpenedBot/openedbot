import { describe, expect, test } from "bun:test";
import { buildBotModeInstructions } from "../src/domain/bot-mode";
import { routineToolRule, type RoutineToolAvailability } from "../src/domain/routine-tool-rule";

const shared = {
  self: { name: "Assistant", slug: "assistant", description: null },
  others: [],
  operator: { username: "operator" },
};
const STATES: RoutineToolAvailability[] = ["enabled", "switched_off", "plan_mode", "not_ready", "unavailable"];

describe("scheduling from the chat in the bot mode block (0187)", () => {
  test("each state has one fixed sentence: the cached prefix does not move from run to run", () => {
    for (const state of STATES) {
      const first = buildBotModeInstructions({ ...shared, routineTool: state });
      expect(buildBotModeInstructions({ ...shared, routineTool: state })).toBe(first);
      expect(first).toContain(routineToolRule(state));
      // Nothing that changes per run (run key, timezone value) lives in the block.
      expect(routineToolRule(state)).not.toMatch(/run_key: [0-9a-f]{8}-|Europe\//);
    }
    expect(new Set(STATES.map(routineToolRule)).size).toBe(STATES.length);
  });

  test("with the tool: create on request, offer then wait for consent, report what exists, ask for the zone", () => {
    const rule = routineToolRule("enabled");
    expect(rule).toContain("`mcp__openedbot_routines__routine_manage`");
    expect(rule).toContain("create it.");
    expect(rule).toContain("offer a routine in one sentence and create it only once they agree");
    expect(rule).toContain("its name, its schedule in plain words with its timezone");
    expect(rule).toContain("change or remove it from your menu \"Routines…\"");
    expect(rule).toContain("when it says unknown, ask them before creating, never guess");
    // The run's history carries the thread's text, not earlier tool calls: a
    // claim about a routine is backed by a call of this turn, and a « hello »
    // once created the same routine again to back the bot's earlier claim
    // (production, 2026-11-12). Each call also costs a model round trip.
    expect(rule).toContain("Never call `routine_manage` for a greeting or small talk.");
    expect(rule).toContain("Create only what the user's current message asks for or agrees to, directly, without listing first; never create again to confirm an earlier routine.");
    expect(rule).toContain("Never claim a routine was created, changed or removed unless a call in this turn confirmed it");
    expect(rule).toContain("To speak of existing routines, list them or repeat only what the conversation already says, without asserting more.");
    expect(rule).not.toContain("Never claim a routine exists");
    expect(rule).not.toContain("earlier in this conversation can be mentioned");
    // One approval per creation on any host: `list` is for finding a job_id or settling a doubt, not a step before creating.
    expect(rule).toContain("`list` only reads: call it when the user asks about their routines, when you are unsure whether a routine already exists, or to find the `job_id` of a routine to update, pause, resume or remove; never guess one.");
    expect(rule).not.toContain("Call `list` before changing a routine");
  });

  test("without the tool: the true reason, the way out the product offers, and no promise", () => {
    for (const state of STATES.filter((value) => value !== "enabled")) {
      const rule = routineToolRule(state);
      // The host may show the tool before openedbot proved it: the bot must not call it.
      expect(rule).toContain("Even if `routine_manage` appears among your tools, do not call it");
      expect(rule).not.toContain("mcp__openedbot_routines__routine_manage");
      expect(rule).not.toContain("run_key");
      expect(rule).toContain("create the routine by hand in your menu \"Routines…\"");
      expect(rule).toContain("never promise to schedule it later");
    }
    expect(routineToolRule("switched_off")).toContain("an operator can also switch scheduling from the chat back on in that menu");
    // English system text: no French product label inside it.
    for (const state of STATES) expect(routineToolRule(state)).not.toContain("Programmer depuis le chat");
    expect(routineToolRule("not_ready")).toContain("waits for the host to come back or for its gateway to be restarted");
    expect(routineToolRule("unavailable")).toContain("cannot carry the scheduling tool");
    expect(routineToolRule("plan_mode")).toContain("You are in plan mode");
    // Only a switched-off bot is told the switch is the way out.
    for (const state of ["not_ready", "unavailable", "plan_mode"] as const) {
      expect(routineToolRule(state)).not.toContain("back on");
    }
  });

  test("a caller that does not say reads as not ready, never as able to schedule", () => {
    expect(buildBotModeInstructions(shared)).toContain(routineToolRule("not_ready"));
  });
});
