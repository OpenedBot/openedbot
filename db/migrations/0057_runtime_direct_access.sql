begin;

-- Encrypted Cloudflare Access credentials for direct runtimes only.
--
-- Idempotent on purpose: the first version of this file recorded nothing in
-- schema_migrations, so the alpha database already carries these columns
-- without the version row. Re-running it must converge instead of failing on
-- "column already exists".
alter table runtimes
  add column if not exists edge_auth_ciphertext text,
  add column if not exists edge_auth_nonce text,
  add column if not exists edge_auth_tag text,
  add column if not exists edge_auth_key_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runtimes_edge_auth_envelope') then
    alter table runtimes
      add constraint runtimes_edge_auth_envelope check (
        (edge_auth_ciphertext is null and edge_auth_nonce is null and edge_auth_tag is null and edge_auth_key_id is null)
        or (reachability = 'direct' and edge_auth_ciphertext is not null and edge_auth_nonce is not null
          and edge_auth_tag is not null and edge_auth_key_id is not null)
      );
  end if;
end $$;

-- Historical host announcements must never enable administration over a public URL.
update runtimes set link_features = '{}'::text[], last_probed_at = null
 where reachability = 'direct';
comment on column organizations.runtime_mode is 'Retired; retained for compatibility, no longer read by API or worker.';

insert into schema_migrations(version) values ('0057_runtime_direct_access') on conflict (version) do nothing;

commit;
