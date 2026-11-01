begin;
create table bot_profile_provisions (
  bot_id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  slug text not null,
  display_name text not null,
  provider text,
  model text,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  attempts integer not null default 0,
  -- Vrai dès qu'un appel de création a pu partir : un profil déjà présent
  -- sous ce nom n'est adopté que dans ce cas (essai interrompu), jamais avant.
  host_create_attempted boolean not null default false,
  -- A qui est le profil de l'hôte qui porte ce nom : 'ours' prouvé créé par
  -- OHB, 'foreign' trouvé avant tout appel (jamais adopté, jamais supprimé),
  -- 'unknown' tant que rien n'est prouvé. Une annulation garde la ligne
  -- ('cancelled') pour que la corbeille puis la purge lisent la même réponse.
  host_profile_ownership text not null default 'unknown' check (host_profile_ownership in ('unknown','ours','foreign')),
  next_attempt_at timestamptz not null default now(),
  error jsonb,
  lease_owner text,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (organization_id, bot_id) references bots(organization_id, id) on delete cascade,
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id),
  check ((provider is null) = (model is null)),
  check (attempts >= 0)
);
create index bot_profile_provision_claim_idx on bot_profile_provisions (next_attempt_at, bot_id)
  where status in ('queued','running');
alter table bot_profile_provisions enable row level security;
alter table bot_profile_provisions force row level security;
create policy bot_profile_provisions_tenant on bot_profile_provisions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy bot_profile_provisions_worker on bot_profile_provisions to ohb_worker using (true) with check (true);
grant select, insert, update on bot_profile_provisions to ohb_api;
grant select, insert, update, delete on bot_profile_provisions to ohb_worker;
comment on table bot_profile_provisions is 'Durable provisioning of managed Hermes profiles for roster bots.';
insert into schema_migrations(version) values ('0122_bot_profile_provisions') on conflict (version) do nothing;
commit;
