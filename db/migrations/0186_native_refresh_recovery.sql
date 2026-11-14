begin;

-- Only a hash of the independent client attempt is retained. Successor tokens
-- are deterministically reconstructed from the old token AND that secret.
-- A retry never extends the absolute recovery window or revives a revoked row.
alter table sessions
  add column refresh_attempt_hash text,
  add column refresh_recovery_until timestamptz,
  add constraint sessions_refresh_recovery_pair check (
    (refresh_attempt_hash is null and refresh_recovery_until is null)
    or (kind = 'native' and refresh_attempt_hash is not null
        and refresh_recovery_until is not null and family_id is not null)
  );

insert into schema_migrations(version) values ('0186_native_refresh_recovery')
on conflict (version) do nothing;
commit;
