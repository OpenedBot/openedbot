-- The worker no longer reads every tenant's audit (least privilege).
--
-- 0152 and 0153 gave ohb_worker a `using (true)` SELECT on `audit_chain` and
-- `audit_worm_orphans`. Neither is needed that wide:
--
-- * `audit_worm_orphans` has no worker reader at all (core or plug-in): the
--   API marks orphans in its own transaction, and no reconciliation job
--   exists yet. Its `reason` is the raw error text of a rolled-back
--   transaction. Policy dropped, SELECT revoked.
-- * `audit_chain` is read by the worker in one place: the `audit` plug-in
--   archives the purged tenant's links (`onTenantDeleting`), one
--   organization at a time. Its `payload` is the anchor record or the signed
--   verdict in clear. The direct SELECT goes; the worker calls
--   `audit_chain_for_purge(org)` instead: one organization, never NULL,
--   only the columns the archive copies.
--
-- The ohb_api policies of both tables are unchanged: tenant
-- (`app.organization_id`) or link credential of a runtime of that same
-- organization, never `using (true)`.
begin;

drop policy if exists audit_worm_orphans_worker on audit_worm_orphans;
revoke all on audit_worm_orphans from ohb_worker;

drop policy if exists audit_chain_worker on audit_chain;
revoke all on audit_chain from ohb_worker;

-- SECURITY DEFINER, owned by the migration role (BYPASSRLS, schema owner),
-- never by an application role: it reads past the forced RLS, so the
-- organization filter below is the only boundary, and a NULL organization
-- is an error rather than "every tenant".
create function public.audit_chain_for_purge(org uuid)
returns table (
  organization_id uuid,
  runtime_id uuid,
  seq bigint,
  kind text,
  object_key text,
  payload jsonb,
  payload_sha256 text,
  prev_hash text,
  hash text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  if org is null then
    raise exception 'audit_chain_for_purge: an organization is required' using errcode = '22004';
  end if;
  return query
    select c.organization_id, c.runtime_id, c.seq, c.kind, c.object_key, c.payload,
           c.payload_sha256, c.prev_hash, c.hash, c.created_at
      from public.audit_chain c
     where c.organization_id = org
     order by c.runtime_id, c.seq;
end;
$$;

-- Owner: the role that owns audit_chain, i.e. the migration role (ohb_migrator
-- in prod and in the RLS proof, the local superuser on a dev database). It
-- reads the table past the forced RLS; an application role never owns it.
do $owner$
declare
  migrator name;
begin
  select t.tableowner into migrator
    from pg_catalog.pg_tables t
   where t.schemaname = 'public' and t.tablename = 'audit_chain';
  if migrator in ('ohb_api', 'ohb_worker', 'ohb_staff') then
    raise exception 'audit_chain_for_purge: % is an application role, not the migration role', migrator;
  end if;
  execute pg_catalog.format('alter function public.audit_chain_for_purge(uuid) owner to %I', migrator);
end;
$owner$;

revoke all on function public.audit_chain_for_purge(uuid) from public;
grant execute on function public.audit_chain_for_purge(uuid) to ohb_worker;

comment on function public.audit_chain_for_purge(uuid) is
  'The local audit chain of ONE organization, for the tenant purge archive (audit plug-in, onTenantDeleting). ohb_worker only; NULL raises 22004.';

insert into schema_migrations(version) values ('0154_audit_worker_least_privilege')
on conflict (version) do nothing;

commit;
