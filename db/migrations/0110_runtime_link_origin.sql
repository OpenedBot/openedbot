-- Origin the connector signed at its last proof of possession.
--
-- The console used to tell a closed link to "retry on its own" and to run
-- `upgrade`, which reconnects only to the URL frozen in the host's link.json.
-- After console.openedbot.app was removed, a host still signing that name
-- can never come back, and nothing in the database said which name it was:
-- the signed URL existed only in the pop_verified log. This column keeps the
-- HTTPS origin (http loopback in development), written on every accepted
-- proof. It is not an address OHB dials.
begin;

alter table runtimes
  add column link_origin text;

alter table runtimes add constraint runtimes_link_origin_check check (
  link_origin is null
  or (
    char_length(link_origin) between 1 and 200
    and link_origin ~ '^https?://[A-Za-z0-9._:-]+$'
  )
);

comment on column runtimes.link_origin is
  'HTTPS origin (http loopback in development) the connector signed at its last proof of possession. Not dialed by OHB.';

insert into schema_migrations(version) values ('0110_runtime_link_origin')
on conflict (version) do nothing;

commit;
