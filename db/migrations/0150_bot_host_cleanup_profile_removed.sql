-- A cleanup proves its profile gone once, then may stay queued for a minute
-- to re-read surviving sessions (0126, DEV-OHB-244). Until now the claim of a
-- new bot's profile under the same name waited for that whole verification:
-- a bot re-created as « CEO » right after deleting the previous « CEO » sat
-- 44 s in « Prépare son profil » (lab, 2026-10-27). `profile_removed_at`
-- records the proof; later passes no longer touch that name, and
-- `claimProfileProvision` no longer waits for them
-- (modules/roster/src/application/bot-host-cleanups.ts, profile-provisions.ts).
begin;

alter table bot_host_cleanups
  add column if not exists profile_removed_at timestamptz;

comment on column bot_host_cleanups.profile_removed_at is
  'When a pass proved the bot''s host profile absent (deleted, or never there). Set once; later verification passes skip the profile, and a new provision under the same name stops waiting.';

insert into schema_migrations(version) values ('0150_bot_host_cleanup_profile_removed')
on conflict (version) do nothing;

commit;
