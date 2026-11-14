begin;
alter table bots
  add column capability_baseline_version integer not null default 0;
insert into schema_migrations(version) values ('0130_bot_capability_baseline') on conflict (version) do nothing;
commit;
