-- Plan 0005, delivery 2: erase the waitlist and the access tiers.
--
-- DESTRUCTIVE, on purpose: the privacy policy promises the waitlist is erased.
-- There is no way back without the pre-0180 backup, which step 4 purges.
--
-- Run it with the worker STOPPED: a worker of delivery 1 that claimed a
-- `waitlist_*` row just before the purge would write its `lease_lost` event
-- afterwards (`email_outbox_events` has no foreign key). The guard below
-- refuses to run while such a lease is live, and the new events constraint
-- refuses that late event if the guard was raced.
--
-- What goes:
-- - the four `waitlist_*` e-mails, every status, and all their events
--   (orphans included), then the kinds themselves from the outbox constraint;
-- - `waitlist_signups`, with its grants;
-- - `users.access_tier` (the alpha/beta/classic tiers);
-- - the legacy columns of `product_features` (`enabled`, `staff_override`),
--   the triggers of 0116 and 0179 that mirrored them, the `waitlist` flag,
--   and the tier audiences (`alpha`, `beta`).
begin;

do $$
begin
  if exists (
    select 1 from email_outbox
     where kind in ('waitlist_confirmation', 'waitlist_access_granted',
                    'waitlist_access_tier_changed', 'waitlist_access_revoked')
       and status = 'sending' and lease_expires_at > now()
  ) then
    raise exception 'a worker is still sending a waitlist e-mail: stop the worker, let its lease expire, then migrate again';
  end if;
end;
$$;

delete from email_outbox_events
 where kind in ('waitlist_confirmation', 'waitlist_access_granted',
                'waitlist_access_tier_changed', 'waitlist_access_revoked');
delete from email_outbox
 where kind in ('waitlist_confirmation', 'waitlist_access_granted',
                'waitlist_access_tier_changed', 'waitlist_access_revoked');

do $$
begin
  if exists (select 1 from email_outbox where left(kind, 9) = 'waitlist_')
     or exists (select 1 from email_outbox_events where left(kind, 9) = 'waitlist_') then
    raise exception 'waitlist e-mails survived the purge';
  end if;
end;
$$;

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'organization_member_invitation',
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

-- The events of an erased kind never come back, not even from a late worker.
alter table email_outbox_events add constraint email_outbox_events_erased_kinds_check
  check (left(kind, 9) <> 'waitlist_');

drop table waitlist_signups;

alter table users drop column access_tier;

drop trigger product_features_sync_legacy_switch on product_features;
drop function sync_legacy_product_feature_switch();
drop trigger product_features_sync_audience on product_features;
drop function sync_product_feature_audience();

alter table product_features drop constraint product_features_waitlist_global_check;
delete from product_features where feature_key = 'waitlist';

update product_features set audience = 'staff', updated_at = now() where audience in ('alpha', 'beta');
alter table product_features drop constraint product_features_audience_check;
alter table product_features add constraint product_features_audience_check
  check (audience in ('off', 'staff', 'all'));
-- 0116's trigger filled the audience of an insert that left it out; without
-- it, a flag nobody configured is off.
alter table product_features alter column audience set default 'off';

alter table product_features drop column enabled, drop column staff_override;

insert into schema_migrations(version) values ('0180_remove_waitlist_and_tiers')
on conflict (version) do nothing;
commit;
