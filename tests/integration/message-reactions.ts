// Message reactions against a real PostgreSQL, under the API role and RLS.
//
// Proved here:
//   1. one member holds two emojis on the same reply, and the history lists both;
//   2. PUT is idempotent (a retried add keeps one row);
//   3. DELETE removes only that member's row for that emoji: another member's
//      same emoji and the member's other emoji stay;
//   4. the aggregate counts members and says which emoji the reader holds;
//   5. another tenant's message is a 404 and gets no row.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { threadHistoryRoutes } from "../../apps/api/src/routes/conversation/thread-history-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppVariables } from "../../apps/api/src/routes/identity/auth";
import { withDisposablePostgres } from "./disposable-postgres";

class ReactionFailure extends Error {}
const check: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new ReactionFailure(code); };
type FixtureApp = {
  use(path: "*", handler: (context: { set(key: "auth", value: AppVariables["auth"]): void }, next: () => Promise<void>) => Promise<void>): void;
  onError(handler: (error: Error, context: { json(value: unknown, status: number): Response }) => Response): void;
  route(path: string, app: unknown): void;
  fetch(request: Request): Promise<Response>;
};

let phase = "prepare";
try {
  await withDisposablePostgres("openedbot88_reactions", async ({ owner, connect }) => {
    const organizationId = crypto.randomUUID();
    const foreignOrganizationId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    const botId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const foreignSectionId = crypto.randomUUID();
    const foreignBotId = crypto.randomUUID();
    const foreignThreadId = crypto.randomUUID();
    const foreignMessageId = crypto.randomUUID();
    phase = "seed";
    await owner.begin(async (tx) => {
      await tx`insert into organizations (id,slug,name) values (${organizationId},${`reactions-${organizationId}`},'Reactions fixture'),
        (${foreignOrganizationId},${`reactions-${foreignOrganizationId}`},'Other tenant')`;
      await tx`insert into users (id,email) values (${userId},${`reactions-${userId}@example.test`}),(${otherUserId},${`reactions-${otherUserId}@example.test`})`;
      await tx`insert into memberships (organization_id,user_id,role) values (${organizationId},${userId},'owner'),(${organizationId},${otherUserId},'member')`;
      for (const [org, section, bot, thread, message] of [
        [organizationId, sectionId, botId, threadId, messageId],
        [foreignOrganizationId, foreignSectionId, foreignBotId, foreignThreadId, foreignMessageId],
      ] as const) {
        await tx`insert into sections (id,organization_id,name,position) values (${section},${org},'Reactions',0)`;
        await tx`insert into bots (id,organization_id,section_id,name,slug,position) values (${bot},${org},${section},'Reactions fixture','reactions-fixture',0)`;
        await tx`insert into threads (id,organization_id,bot_id,title,is_default,hermes_session_id)
          values (${thread},${org},${bot},'Reactions',true,${`fixture:${thread}`})`;
        await tx`insert into messages (id,organization_id,thread_id,role,content)
          values (${message},${org},${thread},'assistant','[{"type":"text","text":"Quel test veux-tu effectuer ?"}]'::jsonb)`;
      }
    });

    phase = "mount";
    const db = await connect("openedbot_api");
    const apiRequire = createRequire(resolve(import.meta.dir, "../../apps/api/package.json"));
    const Hono = (apiRequire("hono") as { Hono: new () => FixtureApp }).Hono;
    const appFor = (memberId: string) => {
      const app = new Hono();
      app.use("*", async (context, next) => {
        context.set("auth", { organizationId, userId: memberId, role: "owner", kind: "web", sessionId: crypto.randomUUID(), credentialHash: "fixture" } as AppVariables["auth"]);
        await next();
      });
      const fail = (error: Error, context: { json(value: unknown, status: number): Response }) =>
        context.json({ code: error instanceof HttpError ? error.code : "fixture_operation_failed" }, (error instanceof HttpError ? error.status : 500) as ContentfulStatusCode);
      app.onError(fail);
      const writes = conversationRoutes(db, {} as BlobStore, { billingEnforced: false } as ApiConfig);
      writes.onError(fail);
      const reads = threadHistoryRoutes(db);
      reads.onError(fail);
      app.route("/", reads);
      app.route("/", writes);
      return app;
    };
    const me = appFor(userId);
    const other = appFor(otherUserId);
    const react = (app: FixtureApp, method: "PUT" | "DELETE", emoji: string, target = messageId, thread = threadId) =>
      app.fetch(new Request(`http://fixture.invalid/${thread}/messages/${target}/reactions`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emoji }),
      }));
    const reactions = async (app: FixtureApp) => {
      const response = await app.fetch(new Request(`http://fixture.invalid/${threadId}/history`));
      check(response.status === 200, "history_http_failed");
      const page = await response.json() as ThreadSnapshot;
      return JSON.stringify(page.messages.find((message) => message.id === messageId)?.reactions ?? null);
    };
    const rows = async () => (await owner<Array<{ user_id: string; emoji: string }>>`
      select user_id, emoji from message_reactions where message_id = ${messageId} order by user_id, emoji`)
      .map((row) => `${row.user_id === userId ? "me" : "other"}:${row.emoji}`).sort().join(",");

    phase = "two-emojis";
    check((await react(me, "PUT", "❤️")).status === 204, "add_heart_failed");
    check((await react(me, "PUT", "👍")).status === 204, "add_thumb_failed");
    check((await react(me, "PUT", "👍")).status === 204, "retried_add_failed");
    check(await rows() === "me:❤️,me:👍", "two_emojis_not_both_stored");
    const listed = JSON.parse(await reactions(me)) as Array<{ emoji: string; count: number; reactedByMe: boolean }>;
    check(listed.length === 2 && listed.every((reaction) => reaction.count === 1 && reaction.reactedByMe), "two_emojis_not_both_listed");

    phase = "other-member";
    check((await react(other, "PUT", "👍")).status === 204, "other_add_failed");
    const shared = JSON.parse(await reactions(other)) as Array<{ emoji: string; count: number; reactedByMe: boolean }>;
    check(shared.find((reaction) => reaction.emoji === "👍")?.count === 2, "count_not_aggregated");
    check(shared.find((reaction) => reaction.emoji === "❤️")?.reactedByMe === false, "reacted_by_me_leaks_across_members");

    phase = "toggle-off";
    check((await react(me, "DELETE", "👍")).status === 204, "remove_failed");
    check(await rows() === "me:❤️,other:👍", "remove_touched_the_wrong_row");
    check((await react(me, "DELETE", "👍")).status === 204, "retried_remove_failed");
    const after = JSON.parse(await reactions(me)) as Array<{ emoji: string; count: number; reactedByMe: boolean }>;
    check(after.find((reaction) => reaction.emoji === "👍")?.reactedByMe === false
      && after.find((reaction) => reaction.emoji === "👍")?.count === 1, "toggle_off_not_reflected");

    phase = "tenant";
    check((await react(me, "PUT", "❤️", foreignMessageId, foreignThreadId)).status === 404, "foreign_message_reachable");
    const foreignRows = await owner`select 1 from message_reactions where message_id = ${foreignMessageId}`;
    check(foreignRows.length === 0, "foreign_message_got_a_reaction");
    check((await react(me, "PUT", "<b>")).status === 400, "arbitrary_emoji_accepted");

    console.info(JSON.stringify({ test: "message-reactions", passed: true }));
  });
} catch (error) {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const safeField = (key: string) => typeof fields[key] === "string" && /^[A-Za-z0-9_]{1,64}$/.test(fields[key] as string) ? fields[key] : undefined;
  console.info(JSON.stringify({ test: "message-reactions", passed: false, phase,
    error: error instanceof ReactionFailure ? error.message : "reaction_operation_failed",
    code: safeField("code"), constraint: safeField("constraint"), table: safeField("table") }));
  process.exitCode = 1;
}
