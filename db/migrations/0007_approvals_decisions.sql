begin;

-- Approbations humaines et journal signé des décisions. Le forwarding d'une
-- décision vers Hermes est une opération durable à part entière : la décision
-- peut être certaine pendant que l'issue HTTP est ambiguë, d'où la machine à
-- états `forward_state` (et non un simple horodatage).

create table approval_requests (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  run_id uuid not null,
  command text,
  description text,
  choices jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','denied','expired')),
  selected_choice text,
  forwarded_at timestamptz,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now(),
  gate_ordinal integer not null default 0,
  forward_state text not null default 'pending',
  forwarding_owner text,
  forwarding_lease_expires_at timestamptz,
  forwarding_epoch bigint not null default 0,
  decision_id uuid,
  unique (organization_id, id),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references runs(organization_id, id) on delete cascade,
  constraint approval_requests_resolved_by_membership_fkey
    foreign key (organization_id, resolved_by)
    references memberships (organization_id, user_id),
  constraint approval_requests_gate_ordinal_nonnegative
    check (gate_ordinal >= 0),
  constraint approval_requests_forwarding_epoch_nonnegative
    check (forwarding_epoch >= 0),
  constraint approval_requests_forward_state_check
    check (forward_state in ('pending', 'ready', 'sending', 'confirmed', 'ambiguous', 'expired'))
);

-- Le produit cloud ne propose volontairement que l'autorisation ponctuelle ou
-- le refus. NOT VALID : les éventuelles lignes historiques restent, chaque
-- nouvelle écriture hors invariant est refusée.
alter table approval_requests
  add constraint approval_requests_selected_choice_product_check
  check (selected_choice is null or selected_choice in ('once', 'deny')) not valid;

create unique index approval_requests_one_active_gate_per_run_idx
  on approval_requests (organization_id, run_id)
  where forward_state in ('pending', 'ready', 'sending', 'ambiguous');
create index approval_requests_forward_claim_idx
  on approval_requests (forwarding_lease_expires_at, created_at)
  where forward_state in ('ready', 'sending');
create index approval_requests_run_gate_ordinal_idx
  on approval_requests (organization_id, run_id, gate_ordinal);
create unique index approval_requests_decision_idx
  on approval_requests (organization_id, decision_id)
  where decision_id is not null;

-- `chain_sequence` : ordinal explicite par chaîne tenant : `created_at`
-- reflète le début de transaction, pas l'ordre d'append ; l'advisory lock
-- garantit un prédécesseur unique même si les transactions ont démarré dans
-- l'ordre inverse.
create table decisions (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  run_id uuid not null,
  approval_request_id uuid,
  actor_user_id uuid,
  choice text not null,
  envelope jsonb not null,
  previous_hash text,
  entry_hash text not null,
  created_at timestamptz not null default now(),
  chain_sequence bigint not null,
  unique (organization_id, id),
  foreign key (organization_id, thread_id) references threads(organization_id, id),
  foreign key (organization_id, run_id) references runs(organization_id, id),
  foreign key (organization_id, approval_request_id) references approval_requests(organization_id, id),
  constraint decisions_actor_membership_fkey
    foreign key (organization_id, actor_user_id)
    references memberships (organization_id, user_id)
);

alter table decisions
  add constraint decisions_choice_product_check
  check (choice in ('once', 'deny')) not valid;

create unique index decisions_organization_chain_sequence_idx
  on decisions (organization_id, chain_sequence);

-- Ce trigger est le mécanisme ACTIF par lequel `status`/`selected_choice`
-- pilotent `forward_state` : la résolution d'une décision
-- (conversation-routes) et l'expiration côté worker écrivent status et
-- selected_choice sans toucher forward_state, et comptent sur lui pour les
-- transitions pending -> ready et * -> expired. Le suffixe `_legacy` est
-- historique ; le retirer exige de porter ces writers sur la machine à états.
create or replace function sync_approval_forward_state_legacy()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.forwarded_at is not null then
    new.forward_state := 'confirmed';
  elsif new.status = 'expired' then
    new.forward_state := 'expired';
  elsif new.selected_choice is not null and new.forward_state = 'pending' then
    new.forward_state := 'ready';
  end if;
  return new;
end;
$$;

create trigger approval_requests_sync_forward_state_legacy
before insert or update of status, selected_choice, forwarded_at on approval_requests
for each row execute function sync_approval_forward_state_legacy();

-- La télémétrie transverse ne peut pas passer par une requête ohb_api
-- ordinaire : FORCE RLS masque, à raison, les lignes sans
-- app.organization_id. Ce definer expose UNE ligne agrégée : aucun id de
-- tenant/user/bot/run/workflow ni contenu persisté ne sort de la fonction.
create or replace function internal_operational_metrics()
returns table (
  run_status_counts jsonb,
  run_external_state_counts jsonb,
  workflow_status_counts jsonb,
  queued_runs bigint,
  oldest_queued_seconds double precision,
  needs_review_runs bigint,
  oldest_unknown_seconds double precision,
  active_workflows bigint,
  unknown_workflows bigint,
  overdue_workflows bigint,
  pending_approvals bigint,
  expired_pending_approvals bigint,
  oldest_pending_approval_seconds double precision,
  relaying_runs bigint,
  oldest_relaying_seconds double precision,
  active_run_leases bigint,
  expired_run_leases bigint,
  missing_run_leases bigint
)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  with run_rows as materialized (
    select status, external_state, events_complete, remote_stop_state,
           created_at, updated_at, lease_owner, lease_expires_at
      from public.runs
  ), workflow_rows as materialized (
    select status, deadline_at from public.workflows
  ), approval_rows as materialized (
    select forward_state, expires_at, created_at from public.approval_requests
  )
  select
    (
      select coalesce(jsonb_object_agg(counts.status, counts.total), '{}'::jsonb)
        from (
          select status, count(*)::bigint as total
            from run_rows group by status
        ) counts
    ),
    (
      select coalesce(jsonb_object_agg(counts.external_state, counts.total), '{}'::jsonb)
        from (
          select external_state, count(*)::bigint as total
            from run_rows group by external_state
        ) counts
    ),
    (
      select coalesce(jsonb_object_agg(counts.status, counts.total), '{}'::jsonb)
        from (
          select status, count(*)::bigint as total
            from workflow_rows group by status
        ) counts
    ),
    (select count(*)::bigint from run_rows where status = 'queued'),
    coalesce((
      select greatest(0::double precision, extract(epoch from (now() - min(created_at))))
        from run_rows where status = 'queued'
    ), 0::double precision),
    (
      select count(*)::bigint from run_rows
       where status = 'unknown'
          or (
            status in ('starting', 'running', 'awaiting_approval')
            and (external_state = 'ambiguous' or remote_stop_state in ('ambiguous', 'failed'))
          )
    ),
    coalesce((
      select greatest(0::double precision, extract(epoch from (now() - min(updated_at))))
        from run_rows
       where status = 'unknown'
          or (
            status in ('starting', 'running', 'awaiting_approval')
            and (external_state = 'ambiguous' or remote_stop_state in ('ambiguous', 'failed'))
          )
    ), 0::double precision),
    (
      select count(*)::bigint from workflow_rows
       where status in ('queued', 'running', 'awaiting_approval', 'reconciling')
    ),
    (select count(*)::bigint from workflow_rows where status = 'unknown'),
    (
      select count(*)::bigint from workflow_rows
       where status in ('queued', 'running', 'awaiting_approval', 'reconciling', 'unknown')
         and deadline_at <= now()
    ),
    (
      select count(*)::bigint from approval_rows
       where forward_state in ('pending', 'ready', 'sending', 'ambiguous')
    ),
    (
      select count(*)::bigint from approval_rows
       where forward_state in ('pending', 'ready', 'sending', 'ambiguous')
         and expires_at <= now()
    ),
    coalesce((
      select greatest(0::double precision, extract(epoch from (now() - min(created_at))))
        from approval_rows
       where forward_state in ('pending', 'ready', 'sending', 'ambiguous')
    ), 0::double precision),
    (select count(*)::bigint from run_rows where status = 'relaying'),
    coalesce((
      select greatest(0::double precision, extract(epoch from (now() - min(created_at))))
        from run_rows where status = 'relaying'
    ), 0::double precision),
    (
      select count(*)::bigint from run_rows
       where status in ('starting', 'running', 'awaiting_approval')
         and lease_owner is not null and lease_expires_at > now()
    ),
    (
      select count(*)::bigint from run_rows
       where status in ('starting', 'running', 'awaiting_approval')
         and lease_expires_at <= now()
    ),
    (
      select count(*)::bigint from run_rows
       where status in ('starting', 'running', 'awaiting_approval')
         and (lease_owner is null or lease_expires_at is null)
    );
$$;

revoke all on function internal_operational_metrics() from public;
grant execute on function internal_operational_metrics() to ohb_api;

alter table approval_requests enable row level security;
alter table approval_requests force row level security;
alter table decisions enable row level security;
alter table decisions force row level security;

create policy approval_requests_tenant on approval_requests to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy approval_requests_worker on approval_requests to ohb_worker using (true) with check (true);

create policy decisions_tenant on decisions to ohb_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy decisions_worker on decisions to ohb_worker using (true) with check (true);

grant select, insert, update, delete on approval_requests to ohb_api;
grant select, insert, update, delete on approval_requests to ohb_worker;
grant select, insert on decisions to ohb_api;
grant select, insert on decisions to ohb_worker;

insert into schema_migrations(version) values ('0007_approvals_decisions')
on conflict (version) do nothing;

commit;
