-- Staff backoffice sign-in is a one-time code sent by e-mail.
-- The clear code never lands here: only its SHA-256, for ten minutes.
begin;

create table staff_login_codes (
  id uuid primary key,
  staff_user_id uuid not null references staff_users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_login_codes_attempts_check check (attempts >= 0 and attempts <= 5)
);

create index staff_login_codes_user_idx
  on staff_login_codes (staff_user_id, created_at desc);

comment on table staff_login_codes is
  'One-time staff sign-in codes. The clear code is only in the e-mail outbox until send; this table keeps the hash.';

alter table staff_login_codes enable row level security;
alter table staff_login_codes force row level security;

-- Same door as staff_users during login: app.staff_email before a session
-- exists, app.staff_user_id once the account is known.
create policy staff_login_codes_api on staff_login_codes to openedbot_api
  using (
    staff_user_id = nullif(current_setting('app.staff_user_id', true), '')::uuid
    or staff_user_id in (
      select id from staff_users
       where lower(email) = nullif(current_setting('app.staff_email', true), '')
    )
  )
  with check (
    staff_user_id = nullif(current_setting('app.staff_user_id', true), '')::uuid
    or staff_user_id in (
      select id from staff_users
       where lower(email) = nullif(current_setting('app.staff_email', true), '')
    )
  );

grant select, insert, update on staff_login_codes to openedbot_api;

-- SQL twin of TRANSACTIONAL_EMAIL_KINDS (contracts/api/src/email-kinds.ts).
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created',
    'staff_password_reset',
    'staff_login_code',
    'support_new_conversation',
    'runtime_link_down',
    'runtime_connector_outdated'
  ));

insert into schema_migrations(version) values ('0112_staff_login_codes')
on conflict (version) do nothing;

commit;
