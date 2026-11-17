/**
 * Single-workspace accounts: direct membership is the only access, with the
 * signatures the previous release calls, and what only the removed agency
 * feature wrote is refused.
 */
import { withDisposablePostgres } from "./disposable-postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const ORG = "71900000-0000-4000-8000-000000000001";
const OTHER = "71900000-0000-4000-8000-000000000002";
const OWNER = "71900000-0000-4000-8000-0000000000a1";
const OUTSIDER = "71900000-0000-4000-8000-0000000000a2";
const ERASED = "71900000-0000-4000-8000-0000000000a3";
const RUNTIME = "71900000-0000-4000-8000-0000000000c1";
const STAFF = "71900000-0000-4000-8000-0000000000d1";

await withDisposablePostgres("openedbot0190_single_workspace", async ({ owner, connect }) => {
  await owner`insert into users (id, email) values
    (${OWNER}, 'owner@single.test'), (${OUTSIDER}, 'outsider@single.test'), (${ERASED}, 'erased@single.test')`;
  await owner`insert into organizations (id, slug, name, kind, personal_owner_user_id) values
    (${ORG}, 'single-a', 'Single A', 'personal', ${OWNER}),
    (${OTHER}, 'single-b', 'Single B', 'personal', ${OUTSIDER})`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${OWNER}, 'owner'), (${OTHER}, ${OUTSIDER}, 'owner')`;
  await owner`insert into membership_events (id, organization_id, actor_user_id, subject_user_id, kind, role)
    values (gen_random_uuid(), ${ORG}, ${OWNER}, ${OWNER}, 'role_changed', 'owner')`;
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', ${RUNTIME.replaceAll("-", "").padEnd(64, "0")}, true, 4)`;
  await owner`insert into runtime_permission_settings (runtime_id, organization_id, terminal_danger_always, updated_by_user_id, updated_by_kind)
    values (${RUNTIME}, ${ORG}, false, ${OWNER}, 'member')`;
  await owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (gen_random_uuid(), 'email_login_code', 'single:kept', 'owner@single.test', 'fr', '{}'::jsonb)`;

  // The previous release selects (role, kind, via_agency_ids) as openedbot_api.
  const api = await connect("openedbot_api");
  const access = async (user: string, org: string) => api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${org}, true)`;
    return tx<Array<{ role: string | null; kind: string; via: string[] }>>`
      select role, kind, via_agency_ids as via from workspace_access(${user}::uuid, ${org}::uuid)`;
  });
  const member = await access(OWNER, ORG);
  assert(member.length === 1 && member[0]!.role === "owner" && member[0]!.kind === "personal" && member[0]!.via.length === 0,
    `workspace_access for a member: ${JSON.stringify(member)}`);
  const stranger = await access(OUTSIDER, ORG);
  assert(stranger.length === 1 && stranger[0]!.role === null, `workspace_access for a non-member: ${JSON.stringify(stranger)}`);
  await owner`update memberships set revoked_at = now() where organization_id = ${OTHER} and user_id = ${OUTSIDER}`;
  const revoked = await access(OUTSIDER, OTHER);
  assert(revoked[0]?.role === null, `workspace_access after revocation: ${JSON.stringify(revoked)}`);
  await owner`update organizations set deleted_at = now() where id = ${OTHER}`;
  assert((await access(OUTSIDER, OTHER)).length === 0, "workspace_access answers for a deleted organization");

  // A backoffice built on the previous payload still finds `kind` and `agencyGrants`.
  await owner`insert into staff_users (id, email, password_hash) values (${STAFF}, 'staff@single.test', 'not-a-real-hash')`;
  const detail = await api.begin(async (tx) => {
    await tx`select set_config('app.staff_user_id', ${STAFF}, true)`;
    return tx<Array<{ payload: { kind: string; agencyGrants: unknown[]; members: unknown[] } }>>`select staff_get_organization(${ORG}) as payload`;
  });
  assert(detail[0]?.payload.kind === "personal" && Array.isArray(detail[0].payload.agencyGrants)
    && detail[0].payload.agencyGrants.length === 0 && detail[0].payload.members.length === 1,
  `staff_get_organization payload: ${JSON.stringify(detail[0]?.payload)}`);

  // Account erasure no longer touches the dropped table.
  const worker = await connect("openedbot_worker");
  const [erased] = await worker<Array<{ outcome: string }>>`select public.erase_account_user(${ERASED}::uuid) as outcome`;
  assert(erased?.outcome === "pseudonymized", `erase_account_user: ${JSON.stringify(erased)}`);

  // What only the removed feature wrote is refused from now on.
  const refuses = async (label: string, write: () => Promise<unknown>) => {
    let error = "";
    try { await write(); } catch (caught) { error = String(caught); }
    assert(error.includes("violates check constraint"), `${label} was accepted: ${error || "no error"}`);
  };
  await refuses("an agency organization", () => owner`insert into organizations (id, slug, name, kind)
    values (gen_random_uuid(), 'single-agency', 'Agency', 'agency')`);
  await refuses("a grant event", () => owner`insert into membership_events (id, organization_id, actor_user_id, kind, role)
    values (gen_random_uuid(), ${ORG}, ${OWNER}, 'agency_revoked', 'agency')`);
  await refuses("a client invitation e-mail", () => owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (gen_random_uuid(), 'agency_client_invitation', 'single:after', 'x@single.test', 'fr', '{}'::jsonb)`);
  await owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (gen_random_uuid(), 'organization_member_invitation', 'single:member-after', 'x@single.test', 'fr', '{}'::jsonb)`;
  await refuses("a delegated actor", () => owner`update runtime_permission_settings
    set updated_by_kind = 'agency', updated_by_agency_organization_id = ${ORG}`);

  console.log("single-workspace accounts: access and refusals verified");
});
