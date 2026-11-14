begin;

-- Reviewer proof, rework-flux-api step 2: what the last SUCCESSFUL check
-- verified. A host that signals a change (`runtimes.inventory_changed_at`,
-- 0160) or reconnects (`runtimes.link_generation`, 0051) makes a proven row
-- due again at once instead of waiting for its two-minute recheck. Only a
-- check that succeeds acknowledges the signal: `checked_at` is written after
-- a transient failure too, so it cannot say what was verified. A signal never
-- counts as a proof; the proof stays bounded by its age, as before.
alter table runtime_review_profiles
  add column if not exists verified_inventory_at timestamptz,
  add column if not exists verified_link_generation bigint;

comment on column runtime_review_profiles.verified_inventory_at is
  'runtimes.inventory_changed_at seen when the last successful check was claimed; a later host signal makes a proven row due again.';
comment on column runtime_review_profiles.verified_link_generation is
  'runtimes.link_generation seen when the last successful check was claimed; a reconnection makes a proven row due again.';

insert into schema_migrations(version) values ('0177_review_profile_verified_watermark') on conflict (version) do nothing;
commit;
