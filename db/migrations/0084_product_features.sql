begin;

create table product_features (
  feature_key text primary key check (feature_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

grant select on product_features to ohb_api;

-- Workspace agency and connector-only enrollment are distinct product gates.
-- Both ship enabled by default for the current Cloud and Edge contract.
insert into product_features (feature_key, enabled) values
  ('agency_workspaces', true),
  ('connector_only_enrollment', true);

insert into schema_migrations(version) values ('0084_product_features') on conflict (version) do nothing;
commit;
