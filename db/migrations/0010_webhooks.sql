begin;

-- Webhooks entrants : un endpoint est une capacité possédée par
-- l'organisation, liée à un fil exact ; seuls des digests SHA-256 de secrets
-- sont persistés. Le journal de management rend create/rotate rejouables.

create table webhook_endpoints (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  created_by_user_id uuid,
  name text not null check (char_length(name) between 1 and 80),
  instructions text not null check (char_length(instructions) between 1 and 20000),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  delivery_count bigint not null default 0 check (delivery_count >= 0),
  last_received_at timestamptz,
  rotated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, created_by_user_id)
    references memberships(organization_id, user_id) on delete set null (created_by_user_id)
);

create index webhook_endpoints_thread_idx
  on webhook_endpoints (organization_id, thread_id, created_at desc)
  where deleted_at is null;

-- La clé d'idempotence et son hash canonique de requête sont durables. La
-- ligne est réservée et acceptée dans la même transaction que
-- message/workflow/run : un crash ne peut pas laisser un reçu revendiquant un
-- travail jamais mis en file.
create table webhook_deliveries (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  endpoint_id uuid not null,
  thread_id uuid not null,
  idempotency_key text not null
    check (char_length(idempotency_key) between 1 and 200 and idempotency_key !~ '[[:cntrl:]]'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('reserved', 'accepted')),
  event_name text check (event_name is null or char_length(event_name) between 1 and 200),
  message_id uuid,
  run_id uuid,
  workflow_id uuid,
  received_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, endpoint_id, idempotency_key),
  foreign key (organization_id, endpoint_id)
    references webhook_endpoints(organization_id, id) on delete restrict,
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, message_id)
    references messages(organization_id, id) on delete set null (message_id),
  foreign key (organization_id, run_id)
    references runs(organization_id, id) on delete set null (run_id),
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete set null (workflow_id),
  check (
    (state = 'reserved' and message_id is null and run_id is null and workflow_id is null and accepted_at is null)
    or
    (state = 'accepted' and message_id is not null and run_id is not null and workflow_id is not null and accepted_at is not null)
  )
);

create index webhook_deliveries_endpoint_received_idx
  on webhook_deliveries (organization_id, endpoint_id, received_at desc);

-- Create/rotate rendent un secret bearer exactement une fois. Ce journal rend
-- une réponse HTTP perdue rejouable sans stocker le secret en clair ; le
-- tombstone clé/hash permanent empêche une clé réutilisée de créer un doublon
-- après expiration de la fenêtre de récupération chiffrée.
create table webhook_management_operations (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  endpoint_id uuid not null,
  operation text not null check (operation in ('webhook.create', 'webhook.rotate')),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  secret_ciphertext text,
  secret_nonce text,
  secret_tag text,
  secret_key_id text,
  recoverable_until timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, operation, idempotency_key),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, endpoint_id)
    references webhook_endpoints(organization_id, id) on delete cascade,
  check (
    (secret_ciphertext is null and secret_nonce is null and secret_tag is null and secret_key_id is null)
    or
    (secret_ciphertext is not null and secret_nonce is not null and secret_tag is not null and secret_key_id is not null)
  )
);

create index webhook_management_operations_recovery_idx
  on webhook_management_operations (organization_id, recoverable_until)
  where secret_ciphertext is not null;

alter table webhook_endpoints enable row level security;
alter table webhook_endpoints force row level security;
alter table webhook_deliveries enable row level security;
alter table webhook_deliveries force row level security;
alter table webhook_management_operations enable row level security;
alter table webhook_management_operations force row level security;

create policy webhook_endpoints_tenant on webhook_endpoints to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy webhook_deliveries_tenant on webhook_deliveries to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

create policy webhook_management_operations_tenant on webhook_management_operations to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

grant select, insert, update, delete on webhook_endpoints to ohb_api;
grant select, insert, update, delete on webhook_deliveries to ohb_api;
grant select, insert, update, delete on webhook_management_operations to ohb_api;

insert into schema_migrations(version) values ('0010_webhooks')
on conflict (version) do nothing;

commit;
