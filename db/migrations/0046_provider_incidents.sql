begin;

-- Incidents fournisseur (quota 429 / auth 401) : un fournisseur non expire
-- est exclu du repli de run. until = last_seen + 6 h (quota) ou 24 h (auth).
-- Efface quand le canari PUT model-selection ou /api/model/options le voit
-- authentifie de nouveau, et quand un run reussit sur ce fournisseur.

create table runtime_provider_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid not null,
  provider text not null,
  kind text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  until timestamptz not null,
  fallback_provider text,
  fallback_model text,
  run_id uuid,
  message text,
  unique (organization_id, id),
  unique (organization_id, runtime_id, provider),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade,
  constraint runtime_provider_incidents_kind_check
    check (kind in ('quota', 'auth')),
  constraint runtime_provider_incidents_provider_len
    check (length(provider) between 1 and 120),
  constraint runtime_provider_incidents_message_bounded
    check (message is null or length(message) <= 500)
);

create index runtime_provider_incidents_runtime_provider_idx
  on runtime_provider_incidents (runtime_id, provider);

create index runtime_provider_incidents_active_idx
  on runtime_provider_incidents (organization_id, runtime_id, until);

comment on table runtime_provider_incidents is
  'Panne quota/auth d un fournisseur d inference, par runtime. Un incident non expire exclut ce fournisseur de resolveRunnableSelection. Repli par run, jamais une reecriture de runtimes.selected_* ni bots.model.';

alter table runtime_provider_incidents enable row level security;
alter table runtime_provider_incidents force row level security;

create policy runtime_provider_incidents_tenant on runtime_provider_incidents to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_provider_incidents_worker on runtime_provider_incidents to openedbot_worker
  using (true) with check (true);

grant select, insert, update, delete on runtime_provider_incidents to openedbot_api;
grant select, insert, update, delete on runtime_provider_incidents to openedbot_worker;

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('account_purge_completed', 'provider_quota_reached'));

insert into schema_migrations(version) values ('0046_provider_incidents')
on conflict (version) do nothing;

commit;
