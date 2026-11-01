begin;

-- Hermes can re-create a session row after DELETE: the background title
-- writer of the run that just ended upserts it (lab, 2026-10-23, DEV-OHB-244).
-- A deleted session whose host profile survives is re-read after a delay and
-- deleted again until it stays absent.
alter table bot_host_cleanups
  add column verify_session_ids text[] not null default '{}',
  add column verify_passes integer not null default 0,
  add constraint bot_host_cleanups_verify_bounds
    check (cardinality(verify_session_ids) <= 2000 and verify_passes >= 0);

insert into schema_migrations(version) values ('0126_bot_host_cleanup_verify');
commit;
