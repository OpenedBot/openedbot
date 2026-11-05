begin;

-- The worker reuses the toolset inventory (`/v1/toolsets`) across
-- runs on the same link instead of paying a relay round trip on every run.
-- The API (or the link gateway) holds the link and relays every host write
-- that can change that inventory (toolset, MCP, OAuth callback, gateway
-- restart, profile creation or deletion, credentials); the worker caches in
-- its own process. This counter is the cross-process invalidation: the broker
-- bumps it after relaying such a write, the worker reads it in its existing
-- run context read and keys its cache on it. No new round trip.
--
-- The SELECT/UPDATE grants on runtimes and their tenant/worker RLS policies
-- already cover the column; nothing else changes.
alter table runtimes
  add column toolset_epoch bigint not null default 0;

comment on column runtimes.toolset_epoch is
  'Bumped after openedbot relays a host write that can change the toolset inventory. Part of the worker inventory cache key; carries no data.';

insert into schema_migrations(version) values ('0104_runtime_toolset_epoch') on conflict (version) do nothing;
commit;
