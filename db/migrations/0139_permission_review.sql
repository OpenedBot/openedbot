begin;

-- PERM2-7a and PERM2-7: the automatic review.
--
-- `runtime_review_profiles` holds, per runtime, the proof that its
-- `openedbot-reviewer` profile has no tool: every toolset off (re-read on
-- `/v1/toolsets`), every inherited MCP server off for it, and the approval
-- plugin in `block_writes`. Without a fresh proof the review is unavailable
-- and `auto` behaves as `manual` on that runtime. The worker writes it; the
-- API only reads it.
create table runtime_review_profiles (
  runtime_id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'proven', 'pending_restart', 'failed')),
  proven_at timestamptz,
  checked_at timestamptz,
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z0-9_]{1,64}$'),
  attempts integer not null default 0 check (attempts >= 0),
  next_check_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'proven') = (proven_at is not null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  foreign key (organization_id, runtime_id) references runtimes(organization_id, id) on delete cascade
);
create index runtime_review_profiles_due_idx on runtime_review_profiles (next_check_at);
alter table runtime_review_profiles enable row level security;
alter table runtime_review_profiles force row level security;
create policy runtime_review_profiles_tenant on runtime_review_profiles for select to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy runtime_review_profiles_worker on runtime_review_profiles to openedbot_worker using (true) with check (true);
grant select on runtime_review_profiles to openedbot_api;
grant select, insert, update, delete on runtime_review_profiles to openedbot_worker;
comment on table runtime_review_profiles is
  'PERM2-7a: proof per runtime that the openedbot-reviewer profile runs without any tool. Written by the worker only.';

-- A gate under review is claimed by one worker at a time: a token and a
-- lease, and the verdict write requires both. `review_started_at` bounds
-- the review end to end (15 s, queue included).
alter table approval_requests
  add column decision_claim_token uuid null,
  add column decision_lease_expires_at timestamptz null,
  add constraint approval_requests_review_claim_check
    check ((decision_claim_token is null) = (decision_lease_expires_at is null));
create index approval_requests_reviewing_idx on approval_requests (created_at)
  where decision_state = 'reviewing' and status = 'pending';

insert into schema_migrations(version) values ('0139_permission_review');
commit;
