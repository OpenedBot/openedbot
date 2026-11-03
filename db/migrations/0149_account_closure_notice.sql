-- The closure notice: the staff tells every account, or a chosen few, that
-- the account and its personal data will be deleted while openedbot.app is
-- rebuilt (sent by the external staff plug-in).
begin;

-- SQL twin of TRANSACTIONAL_EMAIL_KINDS (contracts/api/src/email-kinds.ts).
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'organization_member_invitation',
  'waitlist_confirmation',
  'waitlist_access_granted',
  'waitlist_access_tier_changed',
  'waitlist_access_revoked',
  'staff_account_created',
  'staff_password_reset',
  'staff_login_code',
  'email_login_code',
  'provider_quota_reached',
  'account_purge_completed',
  'account_closure_notice',
  'support_new_conversation',
  'runtime_link_down',
  'runtime_link_restored',
  'runtime_connector_outdated'
));

-- Every account in one read, for a send that must not skip anyone. The
-- paginated staff_search_users is not used for this: its keyset cursor goes
-- through a JavaScript Date, truncated to the millisecond, and two accounts
-- created within the same millisecond could fall between two pages.
-- `total_count` is the whole table: a caller that gets fewer rows than that
-- knows the bound cut the list and must refuse to send.
create function staff_closure_notice_recipients(p_limit int default 5000)
returns table (
  id uuid,
  email text,
  display_name text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  bounded_limit int;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  bounded_limit := least(greatest(coalesce(p_limit, 5000), 1), 20000);

  return query
  select u.id, u.email, u.display_name, count(*) over ()
    from public.users u
   order by u.created_at, u.id
   limit bounded_limit;
end;
$$;

comment on function staff_closure_notice_recipients(int) is
  'Tous les comptes (id, e-mail, nom) pour l''avis de fermeture du backoffice staff, en une lecture, borne plafonnee a 20000. Rend le total de la table : moins de lignes que ce total veut dire que la borne a coupe. Refuse (42501) sans staff actif.';

revoke all on function staff_closure_notice_recipients(int) from public;
grant execute on function staff_closure_notice_recipients(int) to ohb_api;

insert into schema_migrations(version) values ('0149_account_closure_notice')
on conflict (version) do nothing;

commit;
