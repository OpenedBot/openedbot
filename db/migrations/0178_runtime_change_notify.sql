-- Rework-flux-api step 5b: what GET /api/runtime reports changed. Every API
-- replica LISTENs on `openedbot_runtime` (step 5c) and tells the console's
-- open stream (`runtime.changed`), instead of the console polling every 5 s.
--
-- Payload `<organization_id>:<runtime_id>`, delivered after commit only. A
-- hint, never a source of truth: the client rereads `/api/runtime`.
--
-- Fired only when a value the route shows changes (IS DISTINCT FROM). Never
-- on a sign of life (`link_last_seen_at`, `link_agent_seen_at`), a probe date
-- (`last_probed_at`), `updated_at`, the review proof's `checked_at` or
-- `next_check_at`: those change every few seconds and say nothing new.
--
-- Left to the console's slow reread on purpose: what changes with time and
-- no write (a review proof ageing out, an incident whose `until` passes, a
-- link gone silent before the worker's 45 s sweep), and the sources outside
-- these tables (organization policy, model selection proof, exposures).
begin;

create or replace function notify_openedbot_runtime() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    perform pg_catalog.pg_notify('openedbot_runtime', old.organization_id::text || ':' || old.id::text);
  else
    perform pg_catalog.pg_notify('openedbot_runtime', new.organization_id::text || ':' || new.id::text);
  end if;
  return null;
end;
$$;

-- The same hint from a table that hangs off a runtime (`runtime_id`).
create or replace function notify_openedbot_runtime_child() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    perform pg_catalog.pg_notify('openedbot_runtime', old.organization_id::text || ':' || old.runtime_id::text);
  else
    perform pg_catalog.pg_notify('openedbot_runtime', new.organization_id::text || ':' || new.runtime_id::text);
  end if;
  return null;
end;
$$;

-- Repair an unrecorded partial installation from an interrupted migration.
drop trigger if exists runtimes_change_notify on runtimes;
drop trigger if exists runtimes_change_notify_rows on runtimes;
drop trigger if exists runtime_review_profiles_change_notify on runtime_review_profiles;
drop trigger if exists runtime_review_profiles_change_notify_rows on runtime_review_profiles;
drop trigger if exists runtime_provider_incidents_change_notify on runtime_provider_incidents;
drop trigger if exists runtime_provider_incidents_change_notify_rows on runtime_provider_incidents;
drop trigger if exists runtime_link_events_change_notify on runtime_link_events;

create trigger runtimes_change_notify
after update on runtimes
for each row
when ((old.name, old.endpoint, old.capacity, old.revoked_at, old.is_active, old.reachability,
       old.last_health_status, old.last_health_error, old.selected_provider, old.selected_model,
       old.reasoning_effort, old.link_instance_id, old.link_connected_at, old.link_generation,
       old.link_features, old.link_agent, old.link_hermes_version, old.link_origin, old.link_token_rotated_at,
       old.edge_auth_ciphertext is null)
  is distinct from
      (new.name, new.endpoint, new.capacity, new.revoked_at, new.is_active, new.reachability,
       new.last_health_status, new.last_health_error, new.selected_provider, new.selected_model,
       new.reasoning_effort, new.link_instance_id, new.link_connected_at, new.link_generation,
       new.link_features, new.link_agent, new.link_hermes_version, new.link_origin, new.link_token_rotated_at,
       new.edge_auth_ciphertext is null))
execute function notify_openedbot_runtime();

create trigger runtimes_change_notify_rows
after insert or delete on runtimes
for each row execute function notify_openedbot_runtime();

-- The review proof feeds `permissionContext.reviewProven`: a proof gained or
-- lost changes what `auto` means, and so does a proof past its 600 s window
-- (`REVIEW_PROFILE_PROOF_MAX_AGE_SECONDS`, `readReviewProven`) made fresh
-- again with the status unchanged (Codex review). The rechecks of a fresh
-- proof (every two minutes) do not fire.
create trigger runtime_review_profiles_change_notify
after update on runtime_review_profiles
for each row
when (old.status is distinct from new.status
  or (old.proven_at > now() - interval '600 seconds') is distinct from (new.proven_at > now() - interval '600 seconds'))
execute function notify_openedbot_runtime_child();

create trigger runtime_review_profiles_change_notify_rows
after insert or delete on runtime_review_profiles
for each row execute function notify_openedbot_runtime_child();

-- A provider incident opened, closed, requalified (its fallback, its
-- message), or back after it had expired (the upsert only moves `until`).
-- Its `last_seen_at` and an `until` renewed while active do not fire.
create trigger runtime_provider_incidents_change_notify
after update on runtime_provider_incidents
for each row
when ((old.kind, old.fallback_provider, old.fallback_model, old.message)
  is distinct from (new.kind, new.fallback_provider, new.fallback_model, new.message)
  or (old.until > now()) is distinct from (new.until > now()))
execute function notify_openedbot_runtime_child();

create trigger runtime_provider_incidents_change_notify_rows
after insert or delete on runtime_provider_incidents
for each row execute function notify_openedbot_runtime_child();

-- The link's security marks the runtime card shows (`lastReplacedAt`,
-- `hijackSuspectedAt`). Connections and other kinds are already covered by
-- the `runtimes` columns, or not shown.
create trigger runtime_link_events_change_notify
after insert on runtime_link_events
for each row
when (new.kind in ('replaced', 'hijack_suspected'))
execute function notify_openedbot_runtime_child();

insert into schema_migrations(version) values ('0178_runtime_change_notify') on conflict (version) do nothing;
commit;
