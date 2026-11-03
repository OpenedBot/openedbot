begin;

-- Bot creation is replayable: the console mints one request id per creation
-- attempt and sends it with POST /api/bots (and the Marketplace template
-- route). A replay of the same id, after a lost response or a double click,
-- answers the bot already created instead of a second bot, a second host
-- profile or a 409 on the slug. Existing bots keep a null id: nothing to
-- backfill, nothing lost.
alter table bots
  add column creation_request_id uuid null;

-- One bot per (organization, request id). Two tenants may share an id: the
-- index is scoped to the organization, like every roster read under RLS.
create unique index bots_creation_request_idx
  on bots (organization_id, creation_request_id)
  where creation_request_id is not null;

insert into schema_migrations(version) values ('0135_bot_creation_requests');
commit;
