begin;

-- OHB-75: how a direct runtime's gateway got published, before the runtime row exists.
--
-- One exposure per publication attempt. It is created first (tunnel, DNS and Access
-- provisioned on Cloudflare, or a Tailscale Funnel hostname declared), then the
-- host runs the one install command, then the bearer arrives and `runtime_id`
-- is set. Secrets stored here are envelope-encrypted like `runtimes.token_*`
-- and erased as soon as the runtime row carries them. The customer's Cloudflare
-- API token (kind `customer_cloudflare`) is never written anywhere.
create table runtime_direct_exposures (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  runtime_id uuid,
  created_by_user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('customer_cloudflare', 'managed_cloudflare', 'tailscale_funnel')),
  hostname text not null check (hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  endpoint text not null,
  cloudflare_account_id text,
  zone_id text,
  tunnel_id text,
  dns_record_id text,
  access_app_id text,
  service_token_id text,
  install_token_ciphertext text,
  install_token_nonce text,
  install_token_tag text,
  install_token_key_id text,
  edge_auth_ciphertext text,
  edge_auth_nonce text,
  edge_auth_tag text,
  edge_auth_key_id text,
  status text not null default 'awaiting_install'
    check (status in ('awaiting_install', 'reachable', 'declared', 'failed', 'revoked')),
  last_tunnel_status text,
  last_checked_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id),
  constraint runtime_direct_exposures_install_token_envelope check (
    (install_token_ciphertext is null and install_token_nonce is null and install_token_tag is null and install_token_key_id is null)
    or (install_token_ciphertext is not null and install_token_nonce is not null and install_token_tag is not null and install_token_key_id is not null)
  ),
  constraint runtime_direct_exposures_edge_auth_envelope check (
    (edge_auth_ciphertext is null and edge_auth_nonce is null and edge_auth_tag is null and edge_auth_key_id is null)
    or (edge_auth_ciphertext is not null and edge_auth_nonce is not null and edge_auth_tag is not null and edge_auth_key_id is not null)
  ),
  constraint runtime_direct_exposures_cloudflare_shape check (
    kind = 'tailscale_funnel'
    or (cloudflare_account_id is not null and zone_id is not null and tunnel_id is not null)
  )
);

-- A managed hostname is global on OHB's zone: two organizations never share one.
create unique index runtime_direct_exposures_managed_hostname_idx on runtime_direct_exposures (hostname)
  where kind = 'managed_cloudflare' and revoked_at is null;
create index runtime_direct_exposures_org_idx on runtime_direct_exposures (organization_id, created_at desc);
create index runtime_direct_exposures_reconcile_idx on runtime_direct_exposures (last_checked_at asc nulls first)
  where kind = 'managed_cloudflare' and revoked_at is null;

alter table runtime_direct_exposures enable row level security;
alter table runtime_direct_exposures force row level security;
create policy runtime_direct_exposures_tenant on runtime_direct_exposures to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_direct_exposures_worker on runtime_direct_exposures to ohb_worker using (true) with check (true);
grant select, insert, update on runtime_direct_exposures to ohb_api;
grant select, update on runtime_direct_exposures to ohb_worker;

comment on table runtime_direct_exposures is 'OHB-75: publication of a direct gateway (customer Cloudflare, OHB-managed Cloudflare, Tailscale Funnel). Never a customer API token.';
comment on column runtime_direct_exposures.install_token_ciphertext is 'cloudflared connector token, encrypted; erased once the runtime is declared.';

insert into schema_migrations(version) values ('0058_runtime_direct_exposure') on conflict (version) do nothing;

commit;
