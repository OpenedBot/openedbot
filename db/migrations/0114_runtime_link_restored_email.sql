-- The connector of a runtime that was reported down is back: the people who
-- got `runtime_link_down` get `runtime_link_restored`
-- (modules/runtime-link/src/application/link-alerts.ts).
begin;

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
    'runtime_link_restored',
    'runtime_connector_outdated'
  ));

insert into schema_migrations(version) values ('0114_runtime_link_restored_email')
on conflict (version) do nothing;

commit;
