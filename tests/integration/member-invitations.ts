/**
 * Member invitations (0191) against a disposable PostgreSQL database, through
 * the use cases the API calls, as `openedbot_api` (RLS on):
 * - an owner invites, the e-mail is queued, the token previews anonymously;
 * - an invitee without an account signs up by e-mail code and gets NO
 *   workspace; accepting gives the invited role and nothing else;
 * - an account that already has a workspace is refused (409
 *   `MEMBER_ALREADY_IN_WORKSPACE`), and a member cannot create a second one;
 * - a plain member cannot invite, a plan limit is enforced, solo has none;
 * - the invitations of one workspace stay invisible from another.
 */
import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import { hashCredential } from "../../platform/db/src/credential";
import { memberInvitationRoutes } from "../../apps/api/src/routes/identity/member-invitation-routes";
import { memberRoutes } from "../../apps/api/src/routes/identity/member-routes";
import { authMiddleware, type AppVariables } from "../../apps/api/src/routes/identity/auth";
import { HttpError } from "../../contracts/errors/src/http-error";
import { createOrganization } from "../../modules/identity/src/application/accounts";
import { requestEmailLoginCode, verifyEmailLoginCode } from "../../modules/identity/src/application/email-login-code";
import { cancelMemberInvitation, listMemberInvitations, sendMemberInvitation } from "../../modules/identity/src/application/member-invitations";
import { previewMemberInvitation, respondToMemberInvitation } from "../../modules/identity/src/application/member-invitation-consent";
import { removeMember } from "../../modules/identity/src/application/members";
import { installSubscriptionPort, NO_SUBSCRIPTIONS } from "../../modules/identity/src/application/subscription-port";
import type { EmailDomainResolver } from "../../modules/identity/src/application/email-domain-check";
import { withDisposablePostgres } from "./disposable-postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function refusal(action: () => Promise<unknown>): Promise<HttpError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("the action was expected to be refused");
}

const deliverable: EmailDomainResolver = async () => "deliverable";
const WEB_URL = "https://app.invitations.test";

await withDisposablePostgres("openedbot0191_member_invitations", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const db = api as unknown as Db;

  const OWNER = crypto.randomUUID();
  const OUTSIDER = crypto.randomUUID();
  await owner`insert into users (id, email, onboarding_completed) values
    (${OWNER}, 'owner@invitations.test', true), (${OUTSIDER}, 'outsider@invitations.test', true)`;
  const team = await createOrganization(db, { name: "Team" }, OWNER, "test", false);
  const other = await createOrganization(db, { name: "Elsewhere" }, OUTSIDER, "test", false);
  const actor = { organizationId: team.organizationId, userId: OWNER };

  const invite = async (email: string, role: "admin" | "member" = "member") => {
    const invitation = await sendMemberInvitation(db, actor, { email, role, locale: "en", webUrl: WEB_URL }, deliverable);
    const [mail] = await owner<Array<{ payload: { invitationUrl: string; role: string; organizationName: string }; locale: string }>>`
      select payload, locale from email_outbox where kind = 'organization_member_invitation' and recipient_email = ${email}
       order by created_at desc limit 1`;
    assert(mail !== undefined && mail.payload.invitationUrl.startsWith(`${WEB_URL}/invite/member/`), `no invitation e-mail for ${email}: ${JSON.stringify(mail)}`);
    assert(mail.payload.organizationName === "Team" && mail.payload.role === role && mail.locale === "en", `invitation e-mail payload: ${JSON.stringify(mail)}`);
    return { invitation, token: mail.payload.invitationUrl.split("/").at(-1)! };
  };

  // 1. A newcomer: invited, previews, signs up by e-mail code, accepts.
  const newcomer = "newcomer@invitations.test";
  const { token } = await invite(newcomer);
  const preview = await previewMemberInvitation(db, token);
  assert(preview.organizationName === "Team" && preview.email === newcomer && preview.role === "member" && !preview.hasAccount,
    `preview before signup: ${JSON.stringify(preview)}`);
  await requestEmailLoginCode(db, { email: newcomer, locale: "en" });
  const [code] = await owner<Array<{ payload: { code: string } }>>`
    select payload from email_outbox where kind = 'email_login_code' and recipient_email = ${newcomer} order by created_at desc limit 1`;
  const account = await verifyEmailLoginCode(db, { email: newcomer, code: code!.payload.code });
  assert(account.organizationId === null, `signup through the invitation opened a workspace: ${JSON.stringify(account)}`);
  assert((await previewMemberInvitation(db, token)).hasAccount, "the preview does not see the new account");
  const accepted = await respondToMemberInvitation(db, { token, userId: account.userId, accept: true });
  assert(accepted.status === "accepted" && accepted.organizationId === team.organizationId, `accept: ${JSON.stringify(accepted)}`);
  const [joined] = await owner<Array<{ memberships: number; role: string | null; owned: number; onboarded: boolean; events: number }>>`
    select (select count(*)::int from memberships where user_id = ${account.userId} and revoked_at is null) as memberships,
           (select role from memberships where user_id = ${account.userId} and organization_id = ${team.organizationId}) as role,
           (select count(*)::int from organizations where personal_owner_user_id = ${account.userId}) as owned,
           (select onboarding_completed from users where id = ${account.userId}) as onboarded,
           (select count(*)::int from membership_events where organization_id = ${team.organizationId} and kind = 'member_joined') as events`;
  assert(joined?.memberships === 1 && joined.role === "member" && joined.owned === 0 && joined.onboarded && joined.events === 1,
    `after acceptance: ${JSON.stringify(joined)}`);
  assert((await refusal(() => previewMemberInvitation(db, token))).code === "MEMBER_INVITATION_UNAVAILABLE", "an accepted invitation still previews");

  // 2. The member cannot create a workspace of their own, nor invite.
  const second = await refusal(() => createOrganization(db, { name: "Mine" }, account.userId, "test", false));
  assert(second.status === 409 && second.code === "MEMBER_ALREADY_IN_WORKSPACE", `member created a second workspace: ${second.code}`);
  const forbidden = await refusal(() => sendMemberInvitation(db, { organizationId: team.organizationId, userId: account.userId },
    { email: "friend@invitations.test", role: "member", webUrl: WEB_URL }, deliverable));
  assert(forbidden.status === 403 && forbidden.code === "MEMBER_INVITATION_FORBIDDEN", `a member invited: ${forbidden.code}`);

  // 3. An account that already owns a workspace is refused; the invitation stays pending.
  const { invitation: outsiderInvitation, token: outsiderToken } = await invite("outsider@invitations.test", "admin");
  const busy = await refusal(() => respondToMemberInvitation(db, { token: outsiderToken, userId: OUTSIDER, accept: true }));
  assert(busy.status === 409 && busy.code === "MEMBER_ALREADY_IN_WORKSPACE", `an owner of another workspace joined: ${busy.code}`);
  const [outsider] = await owner<Array<{ memberships: number; status: string }>>`
    select (select count(*)::int from memberships where organization_id = ${team.organizationId} and user_id = ${OUTSIDER}) as memberships,
           (select status from organization_member_invitations where id = ${outsiderInvitation.id}) as status`;
  assert(outsider?.memberships === 0 && outsider.status === "pending", `refused acceptance left state: ${JSON.stringify(outsider)}`);
  // Signed in with another address: refused before anything else.
  const mismatch = await refusal(() => respondToMemberInvitation(db, { token: outsiderToken, userId: account.userId, accept: true }));
  assert(mismatch.code === "MEMBER_INVITATION_EMAIL_MISMATCH", `another account answered: ${mismatch.code}`);
  await cancelMemberInvitation(db, actor, outsiderInvitation.id);

  // 4. Tenant isolation: from the other workspace, no invitation of Team is visible.
  const leaked = await api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${other.organizationId}, true)`;
    return tx<Array<{ count: number }>>`select count(*)::int as count from organization_member_invitations`;
  });
  assert(leaked[0]?.count === 0, `invitations leaked across tenants: ${JSON.stringify(leaked)}`);

  // 5. A plan limit counts live members plus pending invitations; solo has none.
  installSubscriptionPort({
    ...NO_SUBSCRIPTIONS,
    read: async () => ({ status: "active", runtimeLimit: 1, memberLimit: 3, concurrentRunLimit: 1, attachmentQuotaBytes: "0" }),
  });
  try {
    await invite("third@invitations.test");
    const quota = await refusal(() => sendMemberInvitation(db, actor, { email: "fourth@invitations.test", role: "member", webUrl: WEB_URL }, deliverable));
    assert(quota.status === 409 && quota.code === "MEMBER_QUOTA_REACHED", `the plan limit was not enforced: ${quota.code}`);
  } finally {
    installSubscriptionPort(null);
  }
  await invite("fourth@invitations.test");

  // 6. Removed, the member may set up a workspace of their own again.
  await removeMember(db, { organizationId: team.organizationId, actorUserId: OWNER, userId: account.userId }, async () => {});
  const own = await createOrganization(db, { name: "Mine" }, account.userId, "test", false);
  assert(own.kind === "personal", `a removed member could not create a workspace: ${JSON.stringify(own)}`);

  // 7. The listing filters the actionable invitations BEFORE its limit: an old
  // pending invitation never hides behind newer settled ones.
  for (const invitation of (await listMemberInvitations(db, actor)).invitations) await cancelMemberInvitation(db, actor, invitation.id);
  const { invitation: oldest } = await invite("oldest@invitations.test");
  for (const email of ["settled-1@invitations.test", "settled-2@invitations.test"]) {
    await cancelMemberInvitation(db, actor, (await invite(email)).invitation.id);
  }
  const one = await listMemberInvitations(db, actor, { limit: 1 });
  assert(one.invitations.length === 1 && one.invitations[0]!.id === oldest.id && !one.truncated,
    `an old pending invitation hid behind settled ones: ${JSON.stringify(one)}`);
  await invite("newer@invitations.test");
  const truncated = await listMemberInvitations(db, actor, { limit: 1 });
  assert(truncated.invitations.length === 1 && truncated.truncated, `a truncated listing did not say so: ${JSON.stringify(truncated)}`);

  // 7b. Over HTTP, through the real routes: an invitee whose account closure
  // is pending gets the API's ACCOUNT_DELETION_PENDING (409), not the
  // membership trigger's 23514 as a 500, and no membership is created.
  const http = new Hono();
  http.route("/api/invite/member", memberInvitationRoutes(db, { trustProxy: false }));
  http.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 409)
    : context.json({ code: "INTERNAL_ERROR", message: String(error) }, 500));
  const closing = crypto.randomUUID();
  const closingEmail = "closing@invitations.test";
  const bearer = `closing-session-${crypto.randomUUID()}`;
  await owner`insert into users (id, email) values (${closing}, ${closingEmail})`;
  await owner`insert into sessions (id, user_id, kind, access_expires_at, session_token_hash)
    values (${crypto.randomUUID()}, ${closing}, 'web', now() + interval '1 day', ${hashCredential(bearer)})`;
  await owner`insert into account_deletions (user_id, purge_after) values (${closing}, now() + interval '30 days')`;
  const { invitation: closingInvitation, token: closingToken } = await invite(closingEmail);
  for (const action of ["accept", "decline"] as const) {
    const answer = await http.request(`/api/invite/member/${closingToken}/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: "{}",
    });
    const body = await answer.json() as { code?: string };
    assert(answer.status === 409 && body.code === "ACCOUNT_DELETION_PENDING", `${action} with a pending closure: ${answer.status} ${JSON.stringify(body)}`);
  }
  const [closingState] = await owner<Array<{ memberships: number; status: string }>>`
    select (select count(*)::int from memberships where user_id = ${closing}) as memberships,
           (select status from organization_member_invitations where id = ${closingInvitation.id}) as status`;
  assert(closingState?.memberships === 0 && closingState.status === "pending", `a pending closure still changed state: ${JSON.stringify(closingState)}`);
  // Closure canceled: the same request goes through.
  await owner`delete from account_deletions where user_id = ${closing}`;
  const reopened = await http.request(`/api/invite/member/${closingToken}/accept`, {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert(reopened.status === 200, `accept after canceling the closure: ${reopened.status} ${await reopened.text()}`);

  // 7c. Resend over HTTP keeps the language the console asks for, like create;
  // without a body it keeps the default (French).
  const ownerBearer = `owner-session-${crypto.randomUUID()}`;
  await owner`insert into sessions (id, user_id, organization_id, kind, access_expires_at, session_token_hash)
    values (${crypto.randomUUID()}, ${OWNER}, ${team.organizationId}, 'web', now() + interval '1 day', ${hashCredential(ownerBearer)})`;
  const tenant = new Hono<{ Variables: AppVariables }>();
  tenant.use("/api/*", authMiddleware(db));
  tenant.route("/api/organization", memberRoutes(db, { webUrl: WEB_URL }, { checkDomain: deliverable }));
  tenant.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 409)
    : context.json({ code: "INTERNAL_ERROR", message: String(error) }, 500));
  const lingo = "lingo@invitations.test";
  const { invitation: lingoInvitation } = await invite(lingo);
  const latestLocale = async () => (await owner<Array<{ locale: string }>>`
    select locale from email_outbox where kind = 'organization_member_invitation' and recipient_email = ${lingo}
     order by created_at desc limit 1`)[0]?.locale;
  for (const [label, init, expected] of [
    ["locale en", { body: JSON.stringify({ locale: "en" }), headers: { "Content-Type": "application/json" } }, "en"],
    ["no body", {}, "fr"],
    ["empty object", { body: "{}", headers: { "Content-Type": "application/json" } }, "fr"],
  ] as const) {
    const resent = await tenant.request(`/api/organization/invitations/${lingoInvitation.id}/resend`, {
      method: "POST", ...init, headers: { Authorization: `Bearer ${ownerBearer}`, ...("headers" in init ? init.headers : {}) },
    });
    assert(resent.status === 200, `resend (${label}): ${resent.status} ${await resent.text()}`);
    const locale = await latestLocale();
    assert(locale === expected, `resend (${label}) queued a ${locale} e-mail, expected ${expected}`);
  }

  // 8. A newcomer creating a workspace while accepting an invitation, in two
  // concurrent transactions: one wins, the other is a 409, never a deadlock.
  const creating = await connect("openedbot_api");
  const accepting = await connect("openedbot_api");
  const outcomes = { created: 0, joined: 0 };
  for (let round = 0; round < 8; round += 1) {
    const racer = crypto.randomUUID();
    const email = `racer-${round}@invitations.test`;
    await owner`insert into users (id, email) values (${racer}, ${email})`;
    const { token: raceToken } = await invite(email);
    const [created, joined] = await Promise.allSettled([
      createOrganization(creating as unknown as Db, { name: `Racer ${round}` }, racer, "test", false),
      respondToMemberInvitation(accepting as unknown as Db, { token: raceToken, userId: racer, accept: true }),
    ]);
    const rejected = [created, joined].filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert(rejected.length === 1, `round ${round}: expected exactly one winner, got ${JSON.stringify([created, joined].map((o) => o.status === "rejected" ? String(o.reason) : "ok"))}`);
    const loser = rejected[0]!.reason;
    assert(loser instanceof HttpError && loser.status === 409 && loser.code === "MEMBER_ALREADY_IN_WORKSPACE",
      `round ${round}: the loser was not a 409 MEMBER_ALREADY_IN_WORKSPACE: ${String(loser)}`);
    if (created.status === "fulfilled") outcomes.created += 1; else outcomes.joined += 1;
    const [state] = await owner<Array<{ living: number }>>`
      select count(*)::int as living from memberships m join organizations o on o.id = m.organization_id
       where m.user_id = ${racer} and m.revoked_at is null and o.deleted_at is null`;
    assert(state?.living === 1, `round ${round}: the account ended with ${state?.living} workspaces`);
  }

  console.log(`0191 member invitations: invite, signup without workspace, accept, one-workspace refusal, roles, limit, listing, RLS and concurrent create/accept (${outcomes.created} created, ${outcomes.joined} joined) verified`);
});
