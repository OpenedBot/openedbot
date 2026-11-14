/**
 * Migration 0190 on a database shaped like production: migrated up to 0189,
 * seeded with personal workspaces only, then 0190. Each guard refuses to run
 * (and changes nothing) while a row still depends on what goes; once the
 * offending row is gone, 0190 runs and leaves direct membership as the only
 * access, with the signatures the previous release calls.
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

await withDisposablePostgres("openedbot0190_single_workspace", async ({ owner, connect, migrateRest }) => {
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

  // Each row a guard must refuse, the fragment of its message, and its removal.
  const blockers: Array<{ name: string; message: string; add: () => Promise<unknown>; remove: () => Promise<unknown> }> = [
    {
      name: "a non-personal organization",
      message: "an organization of another kind than personal exists",
      add: () => owner`insert into organizations (id, slug, name, kind) values ('71900000-0000-4000-8000-000000000003', 'single-c', 'Single C', 'agency')`,
      remove: () => owner`delete from organizations where id = '71900000-0000-4000-8000-000000000003'`,
    },
    {
      name: "a grant",
      message: "agency_grants is not empty",
      add: () => owner`insert into agency_grants (id, agency_organization_id, client_organization_id) values (gen_random_uuid(), ${OTHER}, ${ORG})`,
      remove: () => owner`delete from agency_grants`,
    },
    {
      name: "a client invitation",
      message: "agency_client_invitations is not empty",
      add: () => owner`insert into agency_client_invitations (id, agency_organization_id, email, token_hash)
        values (gen_random_uuid(), ${OTHER}, 'client@single.test', 'single-hash')`,
      remove: () => owner`delete from agency_client_invitations`,
    },
    {
      name: "an account preference",
      message: "account_preferences is not empty",
      add: () => owner`insert into account_preferences (user_id) values (${OWNER})`,
      remove: () => owner`delete from account_preferences`,
    },
    {
      name: "a grant event",
      message: "membership_events holds grant events",
      add: () => owner`insert into membership_events (id, organization_id, actor_user_id, subject_organization_id, kind, role)
        values ('71900000-0000-4000-8000-0000000000e1', ${ORG}, ${OWNER}, ${OTHER}, 'agency_granted', 'agency')`,
      remove: () => owner`delete from membership_events where id = '71900000-0000-4000-8000-0000000000e1'`,
    },
    {
      name: "a delegated actor",
      message: "written by a delegated (agency) actor",
      add: () => owner`update runtime_permission_settings set updated_by_kind = 'agency', updated_by_agency_organization_id = ${OTHER}`,
      remove: () => owner`update runtime_permission_settings set updated_by_kind = 'member', updated_by_agency_organization_id = null`,
    },
    {
      name: "a queued invitation e-mail",
      message: "an invitation e-mail is still queued",
      add: () => owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
        values (gen_random_uuid(), 'organization_member_invitation', 'single:queued', 'x@single.test', 'fr', '{}'::jsonb)`,
      remove: () => owner`delete from email_outbox where dedupe_key = 'single:queued'`,
    },
    {
      name: "a delivered invitation e-mail",
      message: "email_outbox keeps delivered invitation e-mails",
      add: () => owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload, status, sent_at)
        values (gen_random_uuid(), 'agency_client_invitation', 'single:sent', null, 'fr', '{}'::jsonb, 'sent', now())`,
      remove: () => owner`delete from email_outbox where dedupe_key = 'single:sent'`,
    },
  ];

  for (const blocker of blockers) {
    await blocker.add();
    let refused = "";
    try { await migrateRest(); } catch (error) { refused = String(error); }
    assert(refused.includes(blocker.message), `0190 ran over ${blocker.name}: ${refused || "no error"}`);
    const [state] = await owner<Array<{ version: string | null; grants: string | null }>>`
      select (select version from schema_migrations where version = '0190_single_workspace_accounts') as version,
             to_regclass('agency_grants')::text as grants`;
    assert(state !== undefined && state.version === null && state.grants === "agency_grants", `a refused 0190 changed the schema (${blocker.name})`);
    await blocker.remove();
  }

  // Production: only personal workspaces, no grant data. 0190 runs.
  await migrateRest();

  const [gone] = await owner<Array<{ tables: number; functions: number; index: string | null; features: string }>>`
    select (select count(*)::int from unnest(array['agency_grants', 'agency_client_invitations', 'account_preferences']) t(name)
             where to_regclass(t.name) is not null) as tables,
           (select count(*)::int from pg_proc where proname in ('agency_business_summary', 'agency_client_directory', 'agency_authorized_clients')) as functions,
           to_regclass('membership_events_agency_timeline')::text as index,
           (select string_agg(feature_key, ',' order by feature_key) from product_features) as features`;
  assert(gone?.tables === 0 && gone.functions === 0 && gone.index === null, `0190 left a removed object: ${JSON.stringify(gone)}`);
  assert(gone.features === "connector_only_enrollment", `0190 changed the other switches: ${gone.features}`);
  const [kept] = await owner<Array<{ functions: number; mails: number; events: number }>>`
    select (select count(*)::int from pg_proc where proname in ('workspace_run_activity', 'workspace_business_metrics')) as functions,
           (select count(*)::int from email_outbox where dedupe_key = 'single:kept') as mails,
           (select count(*)::int from membership_events where organization_id = ${ORG}) as events`;
  assert(kept?.functions === 2 && kept.mails === 1 && kept.events === 1, `0190 removed what stays: ${JSON.stringify(kept)}`);

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
  assert(erased?.outcome === "pseudonymized", `erase_account_user after 0190: ${JSON.stringify(erased)}`);

  // What only the removed feature wrote is refused from now on.
  const refuses = async (label: string, write: () => Promise<unknown>) => {
    let error = "";
    try { await write(); } catch (caught) { error = String(caught); }
    assert(error.includes("violates check constraint"), `${label} was accepted after 0190: ${error || "no error"}`);
  };
  await refuses("an agency organization", () => owner`insert into organizations (id, slug, name, kind)
    values (gen_random_uuid(), 'single-agency', 'Agency', 'agency')`);
  await refuses("a grant event", () => owner`insert into membership_events (id, organization_id, actor_user_id, kind, role)
    values (gen_random_uuid(), ${ORG}, ${OWNER}, 'agency_revoked', 'agency')`);
  await refuses("a client invitation e-mail", () => owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (gen_random_uuid(), 'agency_client_invitation', 'single:after', 'x@single.test', 'fr', '{}'::jsonb)`);
  // 0191 (applied by the same `migrateRest`) brings the member invitation e-mail back.
  await owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (gen_random_uuid(), 'organization_member_invitation', 'single:member-after', 'x@single.test', 'fr', '{}'::jsonb)`;
  await refuses("a delegated actor", () => owner`update runtime_permission_settings
    set updated_by_kind = 'agency', updated_by_agency_organization_id = ${ORG}`);

  console.log("0190 single-workspace accounts: guards, removal, access and refusals verified");
}, { stopBefore: "0190_" });
