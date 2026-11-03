begin;

-- Signup waitlist as a staff-switchable product feature. Enabled means the
-- Google signup gate is on (current production behaviour). Staff can turn it
-- off from the backoffice; development initializeProductFeatures opens it
-- unless staff_override is set.
insert into product_features (feature_key, enabled, staff_override)
values ('waitlist', true, false)
on conflict (feature_key) do nothing;

insert into schema_migrations(version)
values ('0090_waitlist_product_feature')
on conflict (version) do nothing;

commit;
