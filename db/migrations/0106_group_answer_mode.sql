-- A room answers either member by member (`each`, the historical behavior) or
-- as a team (`team`): after the first round, one member (the room's default
-- responder when it names one, otherwise the first who answered) writes the
-- team's single final answer from the contributions. The worker reads the
-- mode when a round ends; the console renders that synthesis on top of the
-- team card, with the contributions folded under it.
--
-- The first version of this file never recorded itself in schema_migrations:
-- databases that ran it carry the column without the row, so every later
-- `make db-migrate` replayed it and failed. `if not exists` lets that replay
-- record the version instead of failing.
begin;

alter table bot_groups
  add column if not exists answer_mode text not null default 'each'
  constraint bot_groups_answer_mode_check check (answer_mode in ('each', 'team'));

insert into schema_migrations(version) values ('0106_group_answer_mode')
on conflict (version) do nothing;

commit;
