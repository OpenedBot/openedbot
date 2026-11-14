/**
 * The scheduling line of the « bot mode » block (`buildBotModeInstructions`).
 *
 * History: Nova once claimed it had written `profiles/nova/cron/jobs.json`.
 * `cronjob` is refused by contract (runtime-contract.ts) and that store is not
 * mounted in the sandbox: nothing fired. openedbot's routines are the only
 * scheduler. With `routine_manage` (DEV-209) the bot schedules by itself,
 * through that tool only; without it the bot says why and sends the user to
 * the « Routines… » menu, never promising anything.
 *
 * One fixed sentence per state: the block is the cached prefix of every run
 * and must not move from one run to the next while the state holds. What
 * changes per run (the run key, the user's timezone) travels at the end of
 * the input (`withRoutineRunKey`).
 */

/**
 * What a run may say about scheduling from the chat:
 *   - `enabled`: the tool is on the bot's profile and the gateway serves it;
 *   - `switched_off`: the operator turned « Programmer depuis le chat » off;
 *   - `plan_mode`: the bot's mode writes nothing, routines included;
 *   - `not_ready`: being installed, waiting for the host or for a gateway
 *     restart only the operator may trigger;
 *   - `unavailable`: the host or the openedbot API cannot carry the tool.
 */
export type RoutineToolAvailability = "enabled" | "switched_off" | "plan_mode" | "not_ready" | "unavailable";

const NO_OTHER_SCHEDULER = "There is no other scheduler: no cron, no job file, no reminder or background tool, and writing one schedules nothing.";
// A profile can carry the tool's entry before openedbot has proven it (a new
// profile inherits the host's root config): the bot may see `routine_manage`
// with no run key to give it. Measured on the lab host, 2026-11-12.
const DO_NOT_CALL = "Even if `routine_manage` appears among your tools, do not call it in this conversation: it cannot work here.";
const BY_HAND = "they can create the routine by hand in your menu \"Routines…\": it sends you the request at the times they choose, in this conversation";
const NEVER_PROMISE = "Never claim a routine exists and never promise to schedule it later.";

const RULES: Readonly<Record<RoutineToolAvailability, string>> = {
  enabled: [
    "- Recurring or timed tasks: schedule them with your `routine_manage` tool (`mcp__openedbot_routines__routine_manage`), the only scheduler here (no cron, no job file, no background tool).",
    "When the user asks for something recurring or at a given time (\"every Friday at 5 pm\", \"remind me tomorrow at 9\"), create it.",
    "When they describe a recurring or time-bound need without asking for it, offer a routine in one sentence and create it only once they agree.",
    "A time of day needs the user's IANA timezone: take it from the `[routine_manage user timezone: …]` line at the end of their message; when it says unknown, ask them before creating, never guess.",
    "Pass the run key from the `[routine_manage run_key: …]` line.",
    "Never call `routine_manage` for a greeting or small talk. Create only what the user's current message asks for or agrees to, directly, without listing first; never create again to confirm an earlier routine.",
    "`list` only reads: call it when the user asks about their routines, when you are unsure whether a routine already exists, or to find the `job_id` of a routine to update, pause, resume or remove; never guess one.",
    "After a successful call, tell them what now exists: its name, its schedule in plain words with its timezone, and that they can change or remove it from your menu \"Routines…\".",
    "Never claim a routine was created, changed or removed unless a call in this turn confirmed it; when a call fails, say so with its reason. To speak of existing routines, list them or repeat only what the conversation already says, without asserting more.",
  ].join(" "),
  switched_off: `- Scheduling from the chat is switched off for you by an operator of this workspace. When asked for something recurring or at a given time, say so plainly, and tell them ${BY_HAND}; an operator can also switch scheduling from the chat back on in that menu. ${DO_NOT_CALL} ${NO_OTHER_SCHEDULER} ${NEVER_PROMISE}`,
  plan_mode: `- You are in plan mode: you cannot create or change routines. When asked for something recurring or at a given time, describe the routine (name, schedule, timezone) and tell them ${BY_HAND}, or that they can take you out of plan mode. ${DO_NOT_CALL} ${NO_OTHER_SCHEDULER} ${NEVER_PROMISE}`,
  not_ready: `- Scheduling from the chat is not ready on this bot yet: its tool is still being set up on the host computer, or waits for the host to come back or for its gateway to be restarted. When asked for something recurring or at a given time, say plainly that you cannot schedule it from here right now, and tell them ${BY_HAND}. ${DO_NOT_CALL} ${NO_OTHER_SCHEDULER} ${NEVER_PROMISE}`,
  unavailable: `- Scheduling from the chat is not available on this bot: its host computer cannot carry the scheduling tool (the host needs an update, or openedbot a public https address). When asked for something recurring or at a given time, say so plainly and tell them ${BY_HAND}. ${DO_NOT_CALL} ${NO_OTHER_SCHEDULER} ${NEVER_PROMISE}`,
};

export function routineToolRule(state: RoutineToolAvailability): string {
  return RULES[state];
}
