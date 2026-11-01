begin;

create table email_login_codes (
  id uuid primary key,
  email text not null check (email = lower(email)),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_login_codes_email_idx on email_login_codes(email, created_at desc);
alter table email_login_codes enable row level security;
alter table email_login_codes force row level security;
create policy email_login_codes_api on email_login_codes to ohb_api
  using (email = nullif(current_setting('app.login_email', true), ''))
  with check (email = nullif(current_setting('app.login_email', true), ''));
grant select, insert, update on email_login_codes to ohb_api;

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'account_purge_completed', 'provider_quota_reached', 'waitlist_confirmation',
  'waitlist_access_granted', 'waitlist_access_tier_changed', 'waitlist_access_revoked',
  'staff_account_created', 'staff_password_reset', 'staff_login_code', 'email_login_code',
  'support_new_conversation', 'runtime_link_down', 'runtime_link_restored', 'runtime_connector_outdated'
));

insert into schema_migrations(version) values ('0115_email_login_codes')
on conflict (version) do nothing;
commit;
