import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";

type FixtureApp = {
  use(path: "*", handler: (context: { set(key: "auth", value: AppVariables["auth"]): void }, next: () => Promise<void>) => Promise<void>): void;
  route(path: string, app: unknown): void;
  fetch(request: Request): Promise<Response>;
};

export type AdmittedMessage = { runId: string; messageId: string };

/** Exercise the production admission route under openedbot_api RLS, without a provider. */
export async function admitFixtureMessage(
  db: Db,
  auth: AppVariables["auth"],
  threadId: string,
  input: string,
): Promise<AdmittedMessage> {
  const apiRequire = createRequire(resolve(import.meta.dir, "../../apps/api/package.json"));
  const Hono = (apiRequire("hono") as { Hono: new () => FixtureApp }).Hono;
  const app = new Hono();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.route("/", conversationRoutes(db, {} as BlobStore, { billingEnforced: false } as ApiConfig));
  const response = await app.fetch(new Request(`http://fixture.invalid/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ input }),
  }));
  if (response.status !== 202) throw new Error("fixture admission did not return 202");
  const body = await response.json() as { runId?: string; message?: { id?: string; runId?: string }; workflowId?: string | null };
  if (!body.runId || !body.message?.id || body.message.runId !== body.runId || body.workflowId !== null) {
    throw new Error("fixture admission did not return matching message and plain run identities");
  }
  return { runId: body.runId, messageId: body.message.id };
}

/** A separate SQL connection proves the admission transaction committed. */
export async function assertAdmittedMessageDurable(
  db: SQL,
  admitted: AdmittedMessage,
  identity: { organizationId: string; threadId: string; botId: string; userId: string; input: string },
): Promise<void> {
  const rows = await db<Array<{ id: string; runId: string | null; text: string | null; input: string; botId: string | null; userId: string | null }>>`
    select message.id, message.run_id as "runId", message.content #>> '{0,text}' as text,
           run.input, run.bot_id as "botId", run.initiator_user_id as "userId"
      from messages message
      join runs run on run.organization_id = message.organization_id and run.id = message.run_id
     where message.organization_id = ${identity.organizationId} and message.thread_id = ${identity.threadId}
       and message.role = 'user'
  `;
  const row = rows[0];
  if (rows.length !== 1 || row?.id !== admitted.messageId || row.runId !== admitted.runId
    || row.text !== identity.input || row.input !== identity.input
    || row.botId !== identity.botId || row.userId !== identity.userId) {
    throw new Error("admitted user message was lost, duplicated or changed");
  }
  const receipts = await db<Array<{ messageId: string | null; sequence: number }>>`
    select payload ->> 'messageId' as "messageId", sequence
      from run_events
     where organization_id = ${identity.organizationId} and run_id = ${admitted.runId} and type = 'message.admitted'
  `;
  if (receipts.length !== 1 || receipts[0]?.messageId !== admitted.messageId || receipts[0].sequence !== 0) {
    throw new Error("admission receipt was lost, duplicated or changed");
  }
}
