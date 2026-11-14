begin;

-- 0084 shipped agency workspaces enabled in every environment. Record whether
-- staff chose the value so future dev defaults and seeds cannot undo a switch.
alter table product_features
  add column if not exists staff_override boolean not null default false;

-- agency_workspaces was not staff-switchable before this migration, so its existing
-- row is the legacy global default. Reset only that key; leave other features
-- and any later explicit staff choice untouched.
update product_features
   set enabled = false, updated_at = now()
 where feature_key = 'agency_workspaces'
   and staff_override = false;

insert into product_features (feature_key, enabled, staff_override)
values ('agency_workspaces', false, false)
on conflict (feature_key) do nothing;

insert into schema_migrations(version)
values ('0089_agency_workspaces_feature_default')
on conflict (version) do nothing;

commit;
