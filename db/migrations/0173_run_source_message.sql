-- The message a retried run replays.
--
-- An operator retry (`POST /workflows/:id/retry`) creates a new workflow and
-- run that copy the source turn's input, but the operator's message stays
-- bound to the ORIGINAL run: the conversation is not duplicated. The worker
-- reads a turn's images from the user message bound to its run, so a retried
-- DM that carried an image reached Hermes without it while its input still
-- announced one. `runs.source_message_id` names that original message; it is
-- set at insert by the retry (inherited along a chain of retries) and never
-- changes. Null for every other run, which still reads its own message.
begin;

alter table runs
  add column if not exists source_message_id uuid;

alter table runs
  add constraint runs_source_message_fk
    foreign key (organization_id, source_message_id) references messages(organization_id, id)
    on delete set null (source_message_id);

comment on column runs.source_message_id is
  'Retry only: the operator message (bound to the original run) whose attachments this run replays. Set at insert, never changed.';

insert into schema_migrations(version) values ('0173_run_source_message')
on conflict (version) do nothing;

commit;
