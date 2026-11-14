import { Hono } from "hono";
import { strict as assert } from "node:assert";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { workspacePreferencesRoutes } from "../../apps/api/src/routes/notifications/workspace-preferences-routes";
import { workspaceActivationRoutes } from "../../apps/api/src/routes/identity/workspace-activation-routes";
import { conversationFilesRoutes } from "../../apps/api/src/routes/conversation/conversation-files-routes";
import { productExportRoutes } from "../../apps/api/src/routes/conversation/product-export-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { workspacePreferences } from "@openedbot/notifications/application/workspace-preferences";
import {
  processEmailOutbox,
  type TransactionalEmail,
} from "@openedbot/notifications/application/email";
import { withDisposablePostgres } from "./disposable-postgres";

export async function withMvpFixture(
  callback: (fixture: {
    database: Parameters<Parameters<typeof withDisposablePostgres>[1]>[0];
    organizationId: string;
    userId: string;
    botId: string;
    threadId: string;
    sectionId: string;
  }) => Promise<void>,
) {
  await withDisposablePostgres("openedbot189_mvp", async (database) => {
    const { owner } = database;
    const organizationId = crypto.randomUUID(),
      userId = crypto.randomUUID(),
      sectionId = crypto.randomUUID(),
      botId = crypto.randomUUID(),
      threadId = crypto.randomUUID();
    await owner.begin(async (tx) => {
      await tx`insert into organizations(id,slug,name,onboarded_at) values(${organizationId},${`mvp-${organizationId}`},'MVP fixture',now())`;
      await tx`insert into users(id,email,onboarding_completed) values(${userId},${`mvp-${userId}@example.test`},true)`;
      await tx`insert into memberships(organization_id,user_id,role) values(${organizationId},${userId},'owner')`;
      await tx`insert into sections(id,organization_id,name,position) values(${sectionId},${organizationId},'MVP',0)`;
      await tx`insert into bots(id,organization_id,section_id,name,slug,position,instructions) values(${botId},${organizationId},${sectionId},'MVP bot','mvp-bot',0,'Aide-moi à tester.')`;
      await tx`insert into threads(id,organization_id,bot_id,title,hermes_session_id,is_default) values(${threadId},${organizationId},${botId},'MVP conversation',${`mvp-${threadId}`},true)`;
    });
    await callback({
      database,
      organizationId,
      userId,
      sectionId,
      botId,
      threadId,
    });
  });
}

if (import.meta.main)
  await withMvpFixture(
    async ({ database, organizationId, userId, botId, threadId }) => {
      const { owner, connect } = database;
      const api = await connect("openedbot_api");
      const worker = await connect("openedbot_worker");
      let currentUser = userId;
      let currentRole: "owner" | "member" = "owner";
      const app = new Hono<{ Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("auth", {
          organizationId,
          userId: currentUser,
          role: currentRole,
          sessionId: "fixture",
          kind: "web",
          credentialHash: "fixture",
        });
        await next();
      });
      app.onError((error, c) => {
        if (error instanceof HttpError)
          return new Response(
            JSON.stringify({ code: error.code, message: error.message }),
            {
              status: error.status,
              headers: { "Content-Type": "application/json" },
            },
          );
        throw error;
      });
      app.route("/preferences", workspacePreferencesRoutes(api));
      app.route("/activation", workspaceActivationRoutes(api));
      app.route("/threads", conversationFilesRoutes(api));
      app.route("/exports", productExportRoutes(api));
      const request = (path: string, body?: unknown) =>
        app.request(
          path,
          body === undefined
            ? {}
            : {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
        );
      assert.deepEqual(await (await request("/preferences")).json(), {
        approval: false,
        completed: false,
        failed: false,
        locale: "fr",
        checklistHidden: false,
      });
      assert.equal(
        (await request("/preferences", { completed: "true" })).status,
        400,
      );
      assert.equal(
        (await request("/preferences", { extra: true })).status,
        400,
      );
      assert.equal(
        (await request("/preferences", { completed: true, locale: "en" }))
          .status,
        200,
      );
      const otherUser = crypto.randomUUID();
      await owner`insert into users(id,email) values(${otherUser},${`mvp-${otherUser}@example.test`})`;
      await owner`insert into memberships(organization_id,user_id,role) values(${organizationId},${otherUser},'member')`;
      currentUser = otherUser;
      assert.equal(
        (await (await request("/preferences")).json()).completed,
        false,
      );
      currentUser = userId;
      const initial = await (await request("/activation")).json();
      assert.equal(initial.result, false);
      const makeWorkflow = async (origin: string | null = null) => {
        const workflowId = crypto.randomUUID(),
          runId = crypto.randomUUID();
        await owner.begin(async (tx) => {
          await tx`insert into workflows(id,organization_id,thread_id,root_run_id,root_bot_id,initiator_user_id,kind) values(${workflowId},${organizationId},${threadId},${runId},${botId},${userId},'dm')`;
          await tx`insert into runs(id,organization_id,thread_id,bot_id,input,status,output,workflow_id,step_index,step_kind,external_state,initiator_user_id,origin,ended_at)
        values(${runId},${organizationId},${threadId},${botId},'Test','completed','Réponse vérifiée',${workflowId},0,'root','settled',${userId},${origin},now())`;
          await tx`update workflows set status='running',updated_at=clock_timestamp() where id=${workflowId}`;
          await tx`update workflows set status='completed',updated_at=clock_timestamp() where id=${workflowId}`;
        });
        return { workflowId, runId };
      };
      await makeWorkflow("bot_greeting");
      assert.equal((await (await request("/activation")).json()).result, false);
      const { workflowId, runId } = await makeWorkflow();
      assert.equal((await (await request("/activation")).json()).result, true);
      const rows =
        await owner`select * from email_outbox where kind='workflow_completed'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.locale, "en");
      const sent: TransactionalEmail[] = [];
      const sender = {
        send: async (message: TransactionalEmail) => {
          sent.push(message);
        },
      };
      const config = {
        endpoint: null,
        smtpUrl: null,
        brevoApiKey: null,
        resendApiKey: null,
        resendBaseUrl: "https://api.resend.com",
        token: null,
        from: null,
        timeoutMs: 1000,
        leaseSeconds: 60,
        maxAttempts: 2,
        workerId: "mvp-test",
        webAppUrl: "http://localhost:1432",
      };
      assert.equal(await processEmailOutbox(worker, sender, config), "sent");
      assert.equal(sent.length, 1);
      assert.ok(
        String(sent[0]!.data.conversationUrl).includes(`/bot/${botId}`),
      );
      assert.equal(await processEmailOutbox(worker, sender, config), "idle");
      await owner`update workflows set updated_at=clock_timestamp() where id=${workflowId}`;
      assert.equal(
        (
          await owner`select id from email_outbox where kind='workflow_completed'`
        ).length,
        1,
      );
      await makeWorkflow();
      await workspacePreferences(api, organizationId, userId, {
        completed: false,
      });
      assert.equal(await processEmailOutbox(worker, sender, config), "failed");
      assert.equal(sent.length, 1);
      await workspacePreferences(api, organizationId, userId, {
        completed: true,
      });
      assert.equal(await processEmailOutbox(worker, sender, config), "idle");
      await makeWorkflow();
      await owner`update memberships set revoked_at=now() where organization_id=${organizationId} and user_id=${userId}`;
      assert.equal(await processEmailOutbox(worker, sender, config), "failed");
      assert.equal(sent.length, 1);
      await owner`update memberships set revoked_at=null where organization_id=${organizationId} and user_id=${userId}`;
      await makeWorkflow();
      assert.equal(
        await processEmailOutbox(
          worker,
          {
            send: async () => {
              throw new Error("Fixture SMTP unavailable");
            },
          },
          config,
        ),
        "retrying",
      );
      await owner`update email_outbox set available_at=now() where kind='workflow_completed' and status='pending'`;
      assert.equal(await processEmailOutbox(worker, sender, config), "sent");
      assert.equal(sent.length, 2);
      assert.equal(await processEmailOutbox(worker, sender, config), "idle");
      const messageId = crypto.randomUUID();
      await owner`insert into messages(id,organization_id,thread_id,run_id,role,content) values(${messageId},${organizationId},${threadId},${runId},'assistant','[{"type":"text","text":"Résumé français"}]'::jsonb)`;
      const ids = Array.from({ length: 45 }, () => crypto.randomUUID());
      for (const [i, id] of ids.entries())
        await owner`insert into attachments(id,organization_id,message_id,object_key,driver,name,content_type,kind,bytes)
    values(${id},${organizationId},${messageId},${`org/${organizationId}/${id}`},'file',${`rapport-${i}.pdf`},'application/pdf','document',10)`;
      const first = await (await request(`/threads/${threadId}/files`)).json();
      assert.equal(first.files.length, 40);
      assert.ok(first.nextCursor);
      const second = await (
        await request(`/threads/${threadId}/files?cursor=${first.nextCursor}`)
      ).json();
      assert.equal(second.files.length, 5);
      assert.equal(
        (
          await (
            await request(`/threads/${threadId}/files?q=rapport-44`)
          ).json()
        ).files.length,
        1,
      );
      assert.equal(
        (await request(`/threads/${crypto.randomUUID()}/files`)).status,
        404,
      );
      assert.equal(
        (await request(`/threads/${threadId}/files?cursor=bad`)).status,
        400,
      );
      const exported = await request(`/exports/threads/${threadId}`);
      assert.equal(exported.status, 200);
      assert.ok((await exported.text()).includes("Résumé français"));
      const bot = await request(`/exports/bots/${botId}`);
      assert.equal(bot.status, 200);
      const botExport=await bot.json();
      assert.equal(botExport.version, 1);
      assert.equal(typeof botExport.bot.tokenBudget,"number");
      assert.equal(
        (await request(`/exports/bots/${crypto.randomUUID()}`)).status,
        404,
      );
      const foreignOrganization = crypto.randomUUID(),
        foreignSection = crypto.randomUUID(),
        foreignBot = crypto.randomUUID(),
        foreignThread = crypto.randomUUID();
      await owner`insert into organizations(id,slug,name) values(${foreignOrganization},${`foreign-${foreignOrganization}`},'Other workspace')`;
      await owner`insert into sections(id,organization_id,name,position) values(${foreignSection},${foreignOrganization},'Other',0)`;
      await owner`insert into bots(id,organization_id,section_id,name,slug,position) values(${foreignBot},${foreignOrganization},${foreignSection},'Other','other',0)`;
      await owner`insert into threads(id,organization_id,bot_id,title,hermes_session_id,is_default) values(${foreignThread},${foreignOrganization},${foreignBot},'Other',${`other-${foreignThread}`},true)`;
      assert.equal(
        (await request(`/threads/${foreignThread}/files`)).status,
        404,
      );
      assert.equal(
        (await request(`/exports/threads/${foreignThread}`)).status,
        404,
      );
      assert.equal((await request(`/exports/bots/${foreignBot}`)).status, 404);
      currentRole = "member";
      assert.equal((await request(`/exports/bots/${botId}`)).status, 403);
      currentRole = "owner";
      await owner`update workflows set status='failed',updated_at=clock_timestamp() where id=${workflowId}`;
      assert.equal((await (await request("/activation")).json()).result, true);
      console.info(
        "MVP integration PASS: migration, defaults, validation, personal preferences, greeting exclusion, activation, durable email, revocation, dedupe, files, exports",
      );
    },
  );
