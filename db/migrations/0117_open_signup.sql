begin;

-- Operator decision: open signup everywhere. Preserve this choice at startup;
-- staff may still change the global gate in the backoffice afterwards.
insert into product_features (feature_key, enabled, audience, staff_override)
values ('waitlist', false, 'off', true)
on conflict (feature_key) do update
  set enabled = false, audience = 'off', staff_override = true, updated_at = now();

insert into schema_migrations(version) values ('0117_open_signup')
on conflict (version) do nothing;
commit;
