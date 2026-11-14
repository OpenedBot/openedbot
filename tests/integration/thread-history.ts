import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import { threadHistoryRoutes } from "../../apps/api/src/routes/conversation/thread-history-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { withDisposablePostgres } from "./disposable-postgres";

class HistoryFailure extends Error {}
const check: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new HistoryFailure(code); };
type FixtureApp = {
  use(path: "*", handler: (context: { set(key: "auth", value: AppVariables["auth"]): void }, next: () => Promise<void>) => Promise<void>): void;
  onError(handler: (error: Error, context: { json(value: unknown, status: number): Response }) => Response): void;
  route(path: string, app: unknown): void;
  fetch(request: Request): Promise<Response>;
};

let phase = "prepare";
try {
  await withDisposablePostgres("openedbot88_history", async ({ owner, connect }) => {
    const organizationId = crypto.randomUUID();
    const foreignOrganizationId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const botId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const foreignThreadId = crypto.randomUUID();
    const foreignSectionId = crypto.randomUUID();
    const foreignBotId = crypto.randomUUID();
    const count = 1100;
    const workflowIds = Array.from({ length: count }, () => crypto.randomUUID());
    const rootIds: string[] = Array.from({ length: count }, () => crypto.randomUUID());
    const childIds: string[] = Array.from({ length: count }, () => crypto.randomUUID());
    const standaloneIds = [rootIds[0]!, ...Array.from({ length: 9 }, () => crypto.randomUUID())];
    phase = "seed";
    await owner.begin(async (tx) => {
      await tx`insert into organizations (id,slug,name) values (${organizationId},${`history-${organizationId}`},'History fixture'),
        (${foreignOrganizationId},${`history-${foreignOrganizationId}`},'Other tenant')`;
      await tx`insert into users (id,email) values (${userId},${`history-${userId}@example.test`})`;
      await tx`insert into memberships (organization_id,user_id,role) values (${organizationId},${userId},'owner')`;
      await tx`insert into sections (id,organization_id,name,position) values (${sectionId},${organizationId},'History',0)`;
      await tx`insert into bots (id,organization_id,section_id,name,slug,position)
        values (${botId},${organizationId},${sectionId},'History fixture','history-fixture',0)`;
      await tx`insert into threads (id,organization_id,bot_id,title,is_default,hermes_session_id)
        values (${threadId},${organizationId},${botId},'History',true,${`fixture:${threadId}`})`;
      await tx`insert into sections (id,organization_id,name,position) values (${foreignSectionId},${foreignOrganizationId},'Foreign history',0)`;
      await tx`insert into bots (id,organization_id,section_id,name,slug,position)
        values (${foreignBotId},${foreignOrganizationId},${foreignSectionId},'Foreign fixture','foreign-fixture',0)`;
      await tx`insert into threads (id,organization_id,bot_id,title,is_default,hermes_session_id)
        values (${foreignThreadId},${foreignOrganizationId},${foreignBotId},'Foreign history',true,${`fixture:${foreignThreadId}`})`;
      phase = "seed-workflows";
      await tx`insert into workflows (id,organization_id,thread_id,root_run_id,root_bot_id,kind,status,created_at)
        select fixture.workflow_id,${organizationId},${threadId},fixture.root_id,${botId},'dm',
               case when ordinal=1 then 'running' else 'completed' end,
               '2026-10-05T00:00:00.123456Z'::timestamptz + (ordinal-1)*interval '1 microsecond'
          from unnest(${tx.array(workflowIds, "UUID")}::uuid[],${tx.array(rootIds, "UUID")}::uuid[]) with ordinality fixture(workflow_id,root_id,ordinal)`;
      phase = "seed-runs";
      await tx`insert into runs (id,organization_id,thread_id,bot_id,input,status,output,workflow_id,step_index,step_kind,created_at,ended_at,external_state)
        select fixture.root_id,${organizationId},${threadId},${botId},'Fixture input',
               case when ordinal=1 then 'running' else 'completed' end,'Fixture answer',fixture.workflow_id,0,'root',
               '2026-10-05T00:00:00.123456Z'::timestamptz + (ordinal-1)*interval '1 microsecond',
               case when ordinal=1 then null else now() end,
               case when ordinal=1 then 'streaming' else 'settled' end
          from unnest(${tx.array(workflowIds, "UUID")}::uuid[],${tx.array(rootIds, "UUID")}::uuid[]) with ordinality fixture(workflow_id,root_id,ordinal)`;
      await tx`insert into runs (id,organization_id,thread_id,bot_id,input,status,output,workflow_id,step_index,step_kind,created_at,ended_at,external_state)
        select fixture.child_id,${organizationId},${threadId},${botId},'Fixture continuation','completed','Fixture answer',fixture.workflow_id,1,'continuation',
               '2026-10-05T00:00:00.123456Z'::timestamptz + (ordinal-1)*interval '1 microsecond',now(),'settled'
          from unnest(${tx.array(workflowIds, "UUID")}::uuid[],${tx.array(childIds, "UUID")}::uuid[]) with ordinality fixture(workflow_id,child_id,ordinal)`;
      phase = "seed-messages";
      await tx`insert into messages (id,organization_id,thread_id,run_id,role,content,created_at)
        select gen_random_uuid(),${organizationId},${threadId},fixture.root_id,'user','[{"type":"text","text":"Fixture input"}]'::jsonb,
               '2026-10-05T00:00:00.123456Z'::timestamptz + (ordinal-1)*interval '1 microsecond'
          from unnest(${tx.array(rootIds, "UUID")}::uuid[]) with ordinality fixture(root_id,ordinal),generate_series(1,2)`;
      await tx`insert into messages (id,organization_id,thread_id,run_id,role,content)
        select gen_random_uuid(),${organizationId},${threadId},run_id,'assistant','[{"type":"text","text":"Fixture answer"}]'::jsonb
          from unnest(${tx.array(childIds, "UUID")}::uuid[]) fixture(run_id)`;
      await tx`insert into messages (id,organization_id,thread_id,role,content,created_at)
        select id,${organizationId},${threadId},'user','[{"type":"text","text":"Standalone fixture"}]'::jsonb,
               '2026-10-05T00:00:00.123456Z'::timestamptz from unnest(${tx.array(standaloneIds, "UUID")}::uuid[]) fixture(id)`;
      phase = "seed-events";
      await tx`insert into run_events (organization_id,thread_id,run_id,sequence,type,payload,occurred_at)
        select ${organizationId},${threadId},run_id,sequence,
               case when sequence=2 then 'run.completed' else 'agent.message' end,
               case when sequence=2 then '{"output":"Fixture answer"}'::jsonb else '{"text":"Fixture delta"}'::jsonb end,now()
          from unnest(${tx.array([...rootIds,...childIds], "UUID")}::uuid[]) fixture(run_id),generate_series(0,2) sequence`;
    });
    phase = "page-http";
    const db = await connect("openedbot_api");
    let interleave = false;
    const concurrentRunId = crypto.randomUUID();
    let excludedCursor = 0;
    let includedCursor = 0;
    const wrappedDb = { begin: (callback: (tx: TransactionDb) => Promise<unknown>) => db.begin(async (tx) => {
      const wrapped = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        const result = await tx(strings, ...parameters);
        if (interleave && strings.join("").includes("order by anchor_time desc")) {
          interleave = false;
          await owner.begin(async (writer) => {
            await writer`insert into runs (id,organization_id,thread_id,bot_id,input,status,ended_at,external_state)
              values (${concurrentRunId},${organizationId},${threadId},${botId},'Concurrent fixture','completed',now(),'settled')`;
            const excluded = await writer<Array<{ cursor: number }>>`insert into run_events (organization_id,thread_id,run_id,sequence,type,payload,occurred_at)
              values (${organizationId},${threadId},${concurrentRunId},0,'run.completed','{}'::jsonb,now()) returning cursor`;
            const included = await writer<Array<{ cursor: number }>>`insert into run_events (organization_id,thread_id,run_id,sequence,type,payload,occurred_at)
              values (${organizationId},${threadId},${rootIds[0]},3,'agent.message','{"text":"Concurrent delta"}'::jsonb,now()) returning cursor`;
            excludedCursor=Number(excluded[0]!.cursor);
            includedCursor=Number(included[0]!.cursor);
          });
        }
        return result;
      }) as unknown as TransactionDb;
      wrapped.array = tx.array.bind(tx);
      return callback(wrapped);
    }) } as unknown as Db;
    const apiRequire = createRequire(resolve(import.meta.dir,"../../apps/api/package.json"));
    const Hono = (apiRequire("hono") as { Hono: new () => FixtureApp }).Hono;
    const app = new Hono();
    app.use("*",async (context,next) => {
      context.set("auth",{organizationId,userId,role:"owner",kind:"web",sessionId:crypto.randomUUID(),credentialHash:"fixture"} as AppVariables["auth"]);
      await next();
    });
    app.onError((error,context) => context.json({code:error instanceof HttpError ? error.code : "fixture_operation_failed"},(error instanceof HttpError ? error.status : 500) as ContentfulStatusCode));
    const routes = threadHistoryRoutes(wrappedDb);
    routes.onError((error,context) => context.json({code:error instanceof HttpError ? error.code : "fixture_operation_failed"},(error instanceof HttpError ? error.status : 500) as ContentfulStatusCode));
    app.route("/",routes);
    const keys = new Set<string>();
    const runs = new Set<string>();
    const messages = new Set<string>();
    const events = new Set<number>();
    const workflows = new Set<string>();
    const overlap = { runs: 0, messages: 0, events: 0, workflows: 0 };
    let before: string | null = null;
    let pages = 0;
    let firstCursor: string | null = null;
    do {
      const query = new URLSearchParams({turns:"37"});
      if(before) query.set("before",before);
      const response = await app.fetch(new Request(`http://fixture.invalid/${threadId}/history?${query}`));
      check(response.status===200,"history_http_failed");
      const page = await response.json() as ThreadSnapshot;
      check(page.cursor===page.organizationCursor,"history_stream_cursor_not_safe_prefix");
      check(page.history && page.history.turnKeys.length<=37,"history_page_unbounded");
      if(pages===0) {
        check(page.runs.some(run=>run.id===rootIds[0])&&page.runs.some(run=>run.id===childIds[0]),"old_active_workflow_missing");
        firstCursor=page.history.nextBefore;
      }
      for(const key of page.history.turnKeys) {check(!keys.has(key),"duplicate_turn_across_pages");keys.add(key);}
      const pageRunIds=new Set<string>(page.runs.map(run=>run.id));
      for(const root of page.runs.filter(run=>run.stepKind==="root")) {
        const index=rootIds.indexOf(root.id);
        check(index>=0&&pageRunIds.has(childIds[index]!),"workflow_split_across_pages");
        check(page.messages.filter(message=>message.runId===root.id&&message.role==="user").length===2,"folded_inputs_split");
      }
      page.runs.forEach(run=>{if(runs.has(run.id)) overlap.runs+=1;runs.add(run.id);});
      page.messages.forEach(message=>{check(typeof message.sequence==="string","message_order_missing");if(messages.has(message.id)) overlap.messages+=1;messages.add(message.id);});
      page.events.forEach(event=>{check(pageRunIds.has(event.runId),"event_without_its_run");if(events.has(event.cursor)) overlap.events+=1;events.add(event.cursor);});
      page.workflows?.forEach(workflow=>{if(workflows.has(workflow.id)) overlap.workflows+=1;workflows.add(workflow.id);});
      before=page.history.nextBefore;
      check(page.history.hasMore===Boolean(before),"inconsistent_older_cursor");
      pages+=1;
      check(pages<40,"history_cursor_did_not_progress");
    } while(before);
    check(keys.size===count+standaloneIds.length&&runs.size===count*2&&messages.size===count*3+standaloneIds.length
      &&events.size===count*6&&workflows.size===count,"history_rows_lost_beyond_old_caps");
    check(overlap.runs===2&&overlap.messages===3&&overlap.events===6&&overlap.workflows===1,"unexpected_page_overlap_outside_old_active_workflow");
    const foreign = await app.fetch(new Request(`http://fixture.invalid/${foreignThreadId}/history`));
    check(foreign.status===404,"foreign_thread_visible");
    const cross = await app.fetch(new Request(`http://fixture.invalid/${foreignThreadId}/history?before=${firstCursor}`));
    check(cross.status===400,"history_cursor_reused_on_another_thread");
    phase = "concurrent-handoff";
    interleave = true;
    const concurrent = await app.fetch(new Request(`http://fixture.invalid/${threadId}/history?turns=1`));
    check(concurrent.status===200,"concurrent_history_http_failed");
    const concurrentPage = await concurrent.json() as ThreadSnapshot;
    check(concurrentPage.events.some(event=>event.cursor===includedCursor)
      && !concurrentPage.events.some(event=>event.cursor===excludedCursor)
      && concurrentPage.cursor===concurrentPage.organizationCursor
      && concurrentPage.cursor<excludedCursor && excludedCursor<includedCursor,"concurrent_event_handoff_lost");
    console.info(JSON.stringify({test:"thread-history",passed:true,pages,turns:keys.size,runs:runs.size,messages:messages.size,
      events:events.size,workflows:workflows.size,microsecondsRetained:true,oldActiveWorkflowIncluded:true,foldedInputsTogether:true,tenantIsolated:true,
      concurrentLowWaterReplay:true,activeWorkflowOverlap:overlap}));
  });
} catch(error) {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const safeField = (key: string) => typeof fields[key] === "string" && /^[A-Za-z0-9_]{1,64}$/.test(fields[key] as string) ? fields[key] : undefined;
  const column = typeof fields.message === "string" ? /^column "([A-Za-z0-9_]+)"/.exec(fields.message)?.[1] : undefined;
  const castTypes = typeof fields.message === "string" ? /^cannot cast type ([a-z0-9 [\]]+) to ([a-z0-9 [\]]+)/.exec(fields.message)?.slice(1,3) : undefined;
  console.info(JSON.stringify({test:"thread-history",passed:false,phase,error:error instanceof HistoryFailure ? error.message : "history_operation_failed",
    code:safeField("code"),errno:safeField("errno"),constraint:safeField("constraint"),table:safeField("table"),column,castTypes}));
  process.exitCode=1;
}
