begin;

alter table bots
  add column approval_policy_mode text null
    check (approval_policy_mode is null or approval_policy_mode in ('ask_writes', 'block_writes', 'off')),
  add column approval_policy_effective_at timestamptz null;

insert into schema_migrations(version) values ('0125_bot_approval_policy');
commit;
