begin;

-- Facturation Stripe, cycle de vie du tenant (suppression avec grâce, purge
-- des blobs, e-mails transactionnels), télémétrie des services et runtime
-- Hermes du client.

create table subscriptions (
  organization_id uuid primary key references organizations(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  current_period_end timestamptz,
  runtime_limit integer not null default 0,
  member_limit integer not null default 1,
  concurrent_run_limit integer not null default 0,
  attachment_quota_bytes bigint not null default 0,
  stripe_event_created bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table stripe_events (
  id text primary key,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- Grace period : une résiliation ne purge pas le tenant immédiatement.
-- `purge_after` est l'échéance ; null = suppression volontaire immédiate.
-- Un réabonnement pendant la grâce supprime la ligne.
create table tenant_deletions (
  organization_id uuid primary key references organizations(id) on delete cascade,
  reason text not null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  purge_after timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  last_attempt_at timestamptz
);

alter table tenant_deletions
  add constraint tenant_deletions_attempts_nonnegative check (attempts >= 0) not valid;

create index tenant_deletions_claimable_idx
  on tenant_deletions (requested_at)
  where completed_at is null;

-- La ligne organisation est supprimée avant que le stockage objet soit touché.
-- Ce manifeste n'a volontairement AUCUNE FK tenant : il survit à la cascade et
-- se rejoue idempotent après un crash du worker.
create table tenant_blob_deletions (
  object_key text primary key,
  organization_id uuid not null,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  check (attempts >= 0),
  check (length(object_key) between 1 and 1024),
  check (object_key ~ '^org/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
  check (object_key like ('org/' || organization_id::text || '/%'))
);

create index tenant_blob_deletions_claimable_idx
  on tenant_blob_deletions (available_at, created_at);

create table email_outbox (
  id uuid primary key,
  kind text not null check (kind in ('account_purge_completed')),
  dedupe_key text not null unique,
  recipient_email text,
  locale text not null default 'fr',
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object'),
  check (recipient_email is null or (length(recipient_email) between 3 and 320))
);

create index email_outbox_claimable_idx
  on email_outbox (created_at)
  where status in ('pending', 'sending');

create table service_instances (
  id text primary key,
  service text not null check (service in ('api','worker')),
  process_id integer not null,
  rss_bytes bigint not null check (rss_bytes >= 0),
  heap_used_bytes bigint not null check (heap_used_bytes >= 0),
  active_work integer not null default 0 check (active_work >= 0),
  started_at timestamptz not null,
  heartbeat_at timestamptz not null default now()
);

-- Un runtime Hermes par organisation. Le token est chiffré (AES-GCM) avec la
-- clé identifiée par `token_key_id` : la rotation ré-encrypte atomiquement.
-- SSH optionnel : hôte et utilisateur vont ensemble.
create table runtimes (
  id uuid primary key,
  organization_id uuid not null unique references organizations(id) on delete cascade,
  name text not null,
  endpoint text not null,
  token_ciphertext text not null,
  token_nonce text not null,
  token_tag text not null,
  capacity integer not null default 4 check (capacity between 1 and 100),
  revoked_at timestamptz,
  last_health_status text not null default 'unknown',
  last_health_error text,
  last_probed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  selected_provider text,
  selected_model text,
  reasoning_effort text,
  ssh_host text,
  ssh_port integer not null default 22,
  ssh_user text,
  token_key_id text,
  unique (organization_id, id),
  constraint runtimes_reasoning_effort_check
    check (reasoning_effort is null or reasoning_effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
  constraint runtimes_ssh_port_check check (ssh_port between 1 and 65535),
  constraint runtimes_ssh_pair_check
    check ((ssh_host is null and ssh_user is null) or (ssh_host is not null and ssh_user is not null))
);

alter table subscriptions enable row level security;
alter table subscriptions force row level security;
alter table tenant_deletions enable row level security;
alter table tenant_deletions force row level security;
alter table tenant_blob_deletions enable row level security;
alter table tenant_blob_deletions force row level security;
alter table email_outbox enable row level security;
alter table email_outbox force row level security;
alter table runtimes enable row level security;
alter table runtimes force row level security;

create policy subscriptions_tenant on subscriptions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy subscriptions_worker on subscriptions to ohb_worker using (true) with check (true);

create policy tenant_deletions_tenant on tenant_deletions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy tenant_deletions_worker on tenant_deletions to ohb_worker using (true) with check (true);

create policy runtimes_tenant on runtimes to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtimes_worker on runtimes to ohb_worker using (true) with check (true);

create policy tenant_blob_deletions_worker on tenant_blob_deletions to ohb_worker
  using (true) with check (true);
create policy email_outbox_worker on email_outbox to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on subscriptions, runtimes, tenant_deletions to ohb_api;
grant select, insert, update on stripe_events to ohb_api;
grant select, insert, update, delete on service_instances to ohb_api;
grant select, insert, update, delete on subscriptions, runtimes, tenant_deletions to ohb_worker;
grant select, insert, update, delete on service_instances to ohb_worker;
grant select, insert, update, delete on tenant_blob_deletions to ohb_worker;
grant select, insert, update, delete on email_outbox to ohb_worker;

-- Le worker ne touche aux identités que pour la purge de compte finale et
-- explicite. Lectures bornées aux colonnes ; DELETE reste table entière.
grant select (id, email) on users to ohb_worker;
grant delete on users to ohb_worker;

insert into schema_migrations(version) values ('0002_billing_tenant_ops')
on conflict (version) do nothing;

commit;
