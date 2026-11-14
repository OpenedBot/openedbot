import { insertToolErrorTx, backfillToolErrorMessageTx, toolErrorRow } from "../../modules/execution/src/application/tool-errors";
import { readToolErrors } from "../../modules/roster/src/sql/bot-activity";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `91830000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), SECTION = id(2), BOT = id(3), THREAD = id(4), RUN = id(5);
const at = new Date("2026-11-03T00:08:00Z");
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

await withDisposablePostgres("openedbot183_tool_errors", async ({ owner, migrateRest }) => {
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'tool-errors', 'Tool errors')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Bots', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${SECTION}, 'Test', 'test', 0)`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${THREAD}, ${ORG}, ${BOT}, 'Test', 'tool-error-codes', true)`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_kind, step_index)
    values (${RUN}, ${ORG}, ${THREAD}, ${BOT}, 'Test', 'queued', 'root', 0)`;
  const old = '{"output":"ModuleNotFoundError: No module named \'PIL\'", "approval":"Command required approval…';
  await owner`insert into tool_errors (organization_id, bot_id, thread_id, run_id, tool, tool_call_id, error_message, occurred_at)
    values (${ORG}, ${BOT}, ${THREAD}, ${RUN}, 'terminal', 'old', ${old}, ${at})`;
  await migrateRest();
  const legacy = await owner.begin((tx) => readToolErrors(tx, ORG, BOT, 50, null));
  assert(legacy.errors[0]?.errorCode === "PYTHON_DEPENDENCY_MISSING", "Historical incident must be classified");
  assert(legacy.errors[0]?.errorMessage === old, "Migration must preserve the historical diagnostic");

  const context = { id: RUN, organizationId: ORG, botId: BOT, threadId: THREAD };
  const row = toolErrorRow({ type: "tool.result", occurredAt: at,
    payload: { tool: "terminal", toolCallId: "new", error: true, errorMessage: null } });
  assert(row, "Expected an incident row");
  await owner.begin((tx) => insertToolErrorTx(tx, context, row));
  await owner.begin((tx) => backfillToolErrorMessageTx(tx, context, "new", "ModuleNotFoundError: No module named 'PIL' token=abcdefghijk"));
  await owner.begin((tx) => backfillToolErrorMessageTx(tx, context, "new", "Command required approval"));
  const rows = await owner<Array<{ code: string; message: string }>>`
    select error_code as code, error_message as message from tool_errors where tool_call_id = 'new'`;
  assert(rows[0]?.code === "PYTHON_DEPENDENCY_MISSING", "Backfill must store the code and preserve an existing diagnostic");
  assert(rows[0]?.message.includes("[redacted]") && !rows[0]?.message.includes("abcdefghijk"), "Technical detail must be redacted");
  console.log("Tool error codes: migration, legacy reads, persistence and backfill passed.");
}, { stopBefore: "0183_" });
