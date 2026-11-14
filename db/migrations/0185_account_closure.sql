begin;

-- Identity closure is independent of the currently selected workspace. The
-- immutable tenant list is also the cancellation boundary after a partial purge.
create table account_deletions (
  user_id uuid primary key references users(id) on delete restrict,
  organization_ids uuid[] not null default '{}',
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  started_at timestamptz,
  last_error text,
  last_attempt_at timestamptz
);
alter table account_deletions enable row level security;
alter table account_deletions force row level security;
create policy account_deletions_owner on account_deletions to openedbot_api
  using (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid);
create policy account_deletions_worker on account_deletions to openedbot_worker using (true) with check (true);
grant select, insert, delete on account_deletions to openedbot_api;
-- SELECT FOR UPDATE requires UPDATE privilege on at least one column.
grant update (last_error) on account_deletions to openedbot_api;
grant select, update, delete on account_deletions to openedbot_worker;

-- Membership writers already lock the organization before the user. Taking
-- the user lock here closes insertion/reactivation racing final pseudonymization.
create function public.guard_closing_account_membership() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.revoked_at is null then
    -- Match invitation acceptance: serialize with the scheduler's member count.
    perform 1 from public.organizations where id = new.organization_id for no key update;
    -- No newly shared tenant can slip into an already confirmed solo purge.
    if exists (select 1 from public.tenant_deletions where organization_id = new.organization_id and reason = 'account_deleted') then
      raise exception 'Workspace account deletion pending' using errcode = '23514';
    end if;
    perform 1 from public.users where id = new.user_id for update;
    if exists (select 1 from public.account_deletions where user_id = new.user_id)
      or exists (select 1 from public.users where id = new.user_id and email = 'erased+' || new.user_id::text || '@erased.invalid') then
      raise exception 'Account closure pending; cancel it before changing memberships' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_closing_account_membership() from public;
create trigger memberships_closing_account before insert or update on memberships
for each row execute function public.guard_closing_account_membership();

-- Same session-family mutex as native refresh and security revocation. This
-- grants a row lock, never direct UPDATE privileges on users, to the worker.
create function public.lock_account_closure_user(p_user_id uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.users where id = p_user_id for update;
end;
$$;
revoke all on function public.lock_account_closure_user(uuid) from public;
grant execute on function public.lock_account_closure_user(uuid) to openedbot_worker;

-- Never DELETE users: agency actions can reference a user without membership,
-- including ingress with ON DELETE CASCADE. Preserve that shared history.
create or replace function public.erase_account_user(p_user_id uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.users where id = p_user_id for update;
  if not found then return 'absent'; end if;
  if exists (select 1 from public.memberships where user_id = p_user_id and revoked_at is null)
    or exists (select 1 from public.account_deletions where user_id = p_user_id) then
    return 'kept';
  end if;
  delete from public.email_login_codes where email = (select lower(email) from public.users where id = p_user_id);
  update public.users set email = 'erased+' || p_user_id::text || '@erased.invalid',
    password_hash = null, google_subject = null, display_name = null, updated_at = now()
    where id = p_user_id;
  delete from public.sessions where user_id = p_user_id;
  delete from public.native_auth_codes where user_id = p_user_id;
  delete from public.mobile_connect_tickets where user_id = p_user_id;
  delete from public.account_preferences where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.apns_devices where user_id = p_user_id;
  return 'pseudonymized';
end;
$$;
revoke all on function public.erase_account_user(uuid) from public;
grant execute on function public.erase_account_user(uuid) to openedbot_worker;

-- A callback begun before finalization cannot recreate credentials or sessions.
create function public.guard_erased_account_credentials() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if old.email = 'erased+' || old.id::text || '@erased.invalid'
    and (new.email, new.password_hash, new.google_subject) is distinct from (old.email, old.password_hash, old.google_subject) then
    raise exception 'Account is closed' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_erased_account_credentials() from public;
create trigger users_erased_credentials before update on users
for each row execute function public.guard_erased_account_credentials();
create function public.guard_erased_account_session() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform 1 from public.users where id = new.user_id for update;
  if exists (select 1 from public.users where id = new.user_id and email = 'erased+' || new.user_id::text || '@erased.invalid') then
    raise exception 'Account is closed' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_erased_account_session() from public;
create trigger sessions_erased_account before insert on sessions
for each row execute function public.guard_erased_account_session();
create trigger native_codes_erased_account before insert on native_auth_codes
for each row execute function public.guard_erased_account_session();
create trigger mobile_tickets_erased_account before insert on mobile_connect_tickets
for each row execute function public.guard_erased_account_session();

-- Atomic, retryable finalization. Caller holds subscription/organization locks;
-- this repeats the ownership checks at the only privileged mutation boundary.
create function public.finalize_account_closure(p_user_id uuid) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare job public.account_deletions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.organizations o where exists (
    select 1 from public.memberships m where m.organization_id = o.id
      and m.user_id = p_user_id and m.revoked_at is null
  ) order by o.id for no key update;
  perform public.lock_account_closure_user(p_user_id);
  select * into job from public.account_deletions where user_id = p_user_id for update;
  if not found or job.purge_after > now() then return false; end if;
  if exists (select 1 from public.organizations where id = any(job.organization_ids)) then return false; end if;
  if exists (select 1 from public.memberships m where m.user_id = p_user_id and m.revoked_at is null
    and m.role = 'owner' and not exists (
      select 1 from public.memberships other where other.organization_id = m.organization_id
        and other.user_id <> p_user_id and other.role = 'owner' and other.revoked_at is null
    )) then raise exception 'ACCOUNT_DELETION_TRANSFER_REQUIRED'; end if;
  update public.memberships set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  delete from public.account_deletions where user_id = p_user_id;
  if public.erase_account_user(p_user_id) <> 'pseudonymized' then
    raise exception 'Account closure did not erase identity';
  end if;
  return true;
end;
$$;
revoke all on function public.finalize_account_closure(uuid) from public;
grant execute on function public.finalize_account_closure(uuid) to openedbot_worker;

-- Functions must belong to the migration role, never an application role.
do $$
declare migrator name;
begin
  select tableowner into migrator from pg_catalog.pg_tables where schemaname = 'public' and tablename = 'users';
  if migrator in ('openedbot_api', 'openedbot_worker', 'openedbot_staff') then raise exception 'Migration owner required'; end if;
  execute format('alter function public.guard_closing_account_membership() owner to %I', migrator);
  execute format('alter function public.lock_account_closure_user(uuid) owner to %I', migrator);
  execute format('alter function public.guard_erased_account_credentials() owner to %I', migrator);
  execute format('alter function public.guard_erased_account_session() owner to %I', migrator);
  execute format('alter function public.erase_account_user(uuid) owner to %I', migrator);
  execute format('alter function public.finalize_account_closure(uuid) owner to %I', migrator);
end;
$$;
insert into schema_migrations(version) values ('0185_account_closure') on conflict do nothing;
commit;
