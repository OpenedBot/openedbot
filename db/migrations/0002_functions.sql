-- Baseline 2 of 10, generated from the schema of migrations 0001 to 0192.
-- Functions, trigger functions and SECURITY DEFINER helpers. Bodies are not
-- checked at creation: they reference tables created by the next file.

BEGIN;

SET LOCAL check_function_bodies = false;

-- function: advance_workflow_notification_sequence()
CREATE FUNCTION public.advance_workflow_notification_sequence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status is distinct from new.status then
    new.notification_sequence := old.notification_sequence + 1;
  else
    -- Le compteur ne se modifie jamais directement, même par une requête qui
    -- tenterait de l'écrire sans transition de statut.
    new.notification_sequence := old.notification_sequence;
  end if;
  return new;
end;
$$;

-- function: approval_requests_permission_guard()
CREATE FUNCTION public.approval_requests_permission_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  pipeline text;
begin
  select o.permission_pipeline into pipeline from public.organizations o where o.id = new.organization_id;
  if pipeline is distinct from 'v2' then
    return new;
  end if;
  if new.resolved_by_policy is not null and (
    new.decision_stage is null or new.permission_revision_seen is null or new.decided_by_kind is distinct from 'policy'
  ) then
    raise exception 'approval resolved by a policy without the permission pipeline trace'
      using errcode = '23514', hint = 'APPROVAL_POLICY_DECISION_UNTRACKED';
  end if;
  -- A worker that does not know the pipeline leaves a human gate without a
  -- state: in `v2` it is a human's.
  if tg_op = 'INSERT' and new.decision_state is null and new.status = 'pending' then
    new.decision_state := 'awaiting_human';
  end if;
  return new;
end;
$$;

-- function: assign_message_sequence_and_author()
CREATE FUNCTION public.assign_message_sequence_and_author() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.sequence is null then
    insert into public.thread_message_counters as counter (
      organization_id, thread_id, next_sequence, updated_at
    ) values (
      new.organization_id, new.thread_id, 1, now()
    )
    on conflict (organization_id, thread_id) do update
      set next_sequence = counter.next_sequence + 1,
          updated_at = now()
    returning next_sequence - 1 into new.sequence;
  else
    insert into public.thread_message_counters as counter (
      organization_id, thread_id, next_sequence, updated_at
    ) values (
      new.organization_id, new.thread_id, new.sequence + 1, now()
    )
    on conflict (organization_id, thread_id) do update
      set next_sequence = greatest(counter.next_sequence, excluded.next_sequence),
          updated_at = now();
  end if;

  if new.original_author_bot_id is null then
    new.original_author_bot_id := new.author_bot_id;
    if new.original_author_bot_id is null and new.role = 'assistant' then
      select thread.bot_id into new.original_author_bot_id
        from public.threads thread
       where thread.organization_id = new.organization_id and thread.id = new.thread_id;
    end if;
  end if;

  if new.original_author_name is null and new.original_author_bot_id is not null then
    select bot.name into new.original_author_name
      from public.bots bot
     where bot.organization_id = new.organization_id and bot.id = new.original_author_bot_id;
  end if;

  return new;
end;
$$;

-- function: audit_chain_append_only()
CREATE FUNCTION public.audit_chain_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'audit_chain is append-only' using errcode = '42501';
end;
$$;

-- function: audit_chain_for_purge(uuid)
CREATE FUNCTION public.audit_chain_for_purge(org uuid) RETURNS TABLE(organization_id uuid, runtime_id uuid, seq bigint, kind text, object_key text, payload jsonb, payload_sha256 text, prev_hash text, hash text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
#variable_conflict use_column
begin
  if org is null then
    raise exception 'audit_chain_for_purge: an organization is required' using errcode = '22004';
  end if;
  return query
    select c.organization_id, c.runtime_id, c.seq, c.kind, c.object_key, c.payload,
           c.payload_sha256, c.prev_hash, c.hash, c.created_at
      from public.audit_chain c
     where c.organization_id = org
     order by c.runtime_id, c.seq;
end;
$$;

-- comment: FUNCTION audit_chain_for_purge(org uuid)
COMMENT ON FUNCTION public.audit_chain_for_purge(org uuid) IS 'The local audit chain of ONE organization, for the tenant purge archive (audit plug-in, onTenantDeleting). openedbot_worker only; NULL raises 22004.';

-- function: audit_worm_orphans_append_only()
CREATE FUNCTION public.audit_worm_orphans_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'audit_worm_orphans is append-only' using errcode = '42501';
end;
$$;

-- function: bot_permission_grants_revision()
CREATE FUNCTION public.bot_permission_grants_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  update public.bots set permission_revision = permission_revision + 1
   where organization_id = new.organization_id and id = new.bot_id;
  return new;
end;
$$;

-- function: bot_permission_grants_transition()
CREATE FUNCTION public.bot_permission_grants_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if (new.id, new.organization_id, new.bot_id, new.tool_key, new.created_by_user_id, new.created_by_kind,
      new.created_by_agency_organization_id, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.bot_id, old.tool_key, old.created_by_user_id, old.created_by_kind,
      old.created_by_agency_organization_id, old.created_at) then
    raise exception 'a permission grant is immutable'
      using errcode = '23514', hint = 'PERMISSION_GRANT_IMMUTABLE';
  end if;
  if new.created_from_approval_id is not null and new.created_from_approval_id is distinct from old.created_from_approval_id then
    raise exception 'a permission grant keeps the gate it came from'
      using errcode = '23514', hint = 'PERMISSION_GRANT_IMMUTABLE';
  end if;
  if old.status = 'revoked' and (new.status, new.revoked_at, new.revoked_by_user_id, new.revoked_by_kind, new.revoked_reason)
     is distinct from (old.status, old.revoked_at, old.revoked_by_user_id, old.revoked_by_kind, old.revoked_reason) then
    raise exception 'a revoked permission grant is final'
      using errcode = '23514', hint = 'PERMISSION_GRANT_TRANSITION';
  end if;
  return new;
end;
$$;

-- function: bot_permission_rules_limit()
CREATE FUNCTION public.bot_permission_rules_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  stored integer;
begin
  if new.bot_id is null and not exists (
    select 1 from public.memberships m
     where m.organization_id = new.organization_id and m.user_id = new.created_by_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required for an organization rule'
      using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'bot_permission_rules:' || new.organization_id::text || ':' || coalesce(new.bot_id::text, 'organization') || ':' || new.kind, 0));
  select count(*) into stored
    from public.bot_permission_rules r
   where r.organization_id = new.organization_id
     and r.bot_id is not distinct from new.bot_id
     and r.kind = new.kind;
  if stored >= 20 then
    raise exception 'at most 20 permission rules of this kind in this scope'
      using errcode = '23514', hint = 'PERMISSION_RULES_LIMIT';
  end if;
  return new;
end;
$$;

-- function: bot_permission_rules_revision()
CREATE FUNCTION public.bot_permission_rules_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  target record;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  if target.bot_id is null then
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = target.organization_id;
  else
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = target.organization_id and id = target.bot_id;
  end if;
  return null;
end;
$$;

-- function: bot_permission_tool_policies_revision()
CREATE FUNCTION public.bot_permission_tool_policies_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  target record;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  update public.bots set permission_revision = permission_revision + 1
   where organization_id = target.organization_id and id = target.bot_id;
  -- A key moved to another bot (never done by the API) bumps both.
  if tg_op = 'UPDATE' and (old.organization_id, old.bot_id) is distinct from (new.organization_id, new.bot_id) then
    update public.bots set permission_revision = permission_revision + 1
     where organization_id = old.organization_id and id = old.bot_id;
  end if;
  return null;
end;
$$;

-- function: bots_permission_ceiling_guard()
CREATE FUNCTION public.bots_permission_ceiling_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  ceiling text;
  rank_new integer;
  rank_old integer;
begin
  if tg_op = 'UPDATE' and new.permission_mode is not distinct from old.permission_mode then
    return new;
  end if;
  select p.max_mode into ceiling
    from public.organization_permission_policies p
   where p.organization_id = new.organization_id;
  if ceiling is null then
    return new;
  end if;
  rank_new := case new.permission_mode when 'auto' then 1 when 'bypass' then 2 else 0 end;
  rank_old := case when tg_op = 'UPDATE' then
    case old.permission_mode when 'auto' then 1 when 'bypass' then 2 else 0 end
  else 0 end;
  if rank_new > (case ceiling when 'auto' then 1 when 'bypass' then 2 else 0 end) and rank_new > rank_old then
    raise exception 'permission mode above the organization ceiling'
      using errcode = '42501', hint = 'PERMISSION_MODE_ABOVE_CEILING';
  end if;
  return new;
end;
$$;

-- function: bots_raise_permission_revision()
CREATE FUNCTION public.bots_raise_permission_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  new.permission_revision := greatest(
    new.permission_revision,
    old.permission_revision + case when new.permission_mode is distinct from old.permission_mode then 1 else 0 end
  );
  return new;
end;
$$;

-- function: drop_apns_devices_of_revoked_member()
CREATE FUNCTION public.drop_apns_devices_of_revoked_member() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.apns_devices
     where organization_id = new.organization_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

-- function: drop_push_subscriptions_of_revoked_member()
CREATE FUNCTION public.drop_push_subscriptions_of_revoked_member() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.push_subscriptions
     where organization_id = new.organization_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

-- function: enqueue_workflow_email()
CREATE FUNCTION public.enqueue_workflow_email() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare category text; enabled_at timestamptz; destination text; lang text; bot_name text;
begin
  if old.status is not distinct from new.status or new.initiator_user_id is null then return new; end if;
  category := case when new.status = 'awaiting_approval' then 'approval'
    when new.status = 'completed' then 'completed'
    when new.status in ('failed','expired','unknown') then 'failed' end;
  if category is null then return new; end if;
  select case category when 'approval' then p.approval_enabled_at
    when 'completed' then p.completed_enabled_at else p.failed_enabled_at end, u.email,p.locale
    into enabled_at,destination,lang
    from public.user_workspace_preferences p
    join public.memberships m on m.organization_id=p.organization_id and m.user_id=p.user_id and m.revoked_at is null
    join public.users u on u.id=p.user_id
    join public.organizations o on o.id=p.organization_id and o.deleted_at is null
    where p.organization_id=new.organization_id and p.user_id=new.initiator_user_id;
  if enabled_at is null or enabled_at > new.updated_at then return new; end if;
  select name into bot_name from public.bots where organization_id=new.organization_id and id=new.root_bot_id and deleted_at is null;
  -- A greeting/probe is not a user mission.
  if exists(select 1 from public.runs where id=new.root_run_id and origin in ('bot_greeting','persona_draft','compaction')) then return new; end if;
  insert into public.email_outbox(id,kind,dedupe_key,recipient_email,locale,payload)
    values(gen_random_uuid(),'workflow_' || category,
      'workflow:' || new.id || ':' || new.notification_sequence || ':' || new.initiator_user_id || ':' || category,
      destination,lang,jsonb_build_object('organizationId',new.organization_id,'userId',new.initiator_user_id,
        'workflowId',new.id,'sequence',new.notification_sequence,'category',category,'occurredAt',new.updated_at,
        'botName',coalesce(bot_name,'openedbot'),'threadId',new.thread_id,
        'route',(select case when t.bot_id is not null then '/bot/' || t.bot_id || case when t.is_default then '' else '?task=' || t.id end
          else '/g/' || t.group_id end from public.threads t where t.organization_id=new.organization_id and t.id=new.thread_id)))
    on conflict do nothing;
  return new;
end; $$;

-- function: erase_account_user(uuid)
CREATE FUNCTION public.erase_account_user(p_user_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.users where id = p_user_id for update;
  if not found then return 'absent'; end if;
  if exists (select 1 from public.memberships where user_id = p_user_id and revoked_at is null)
    or exists (select 1 from public.account_deletions where user_id = p_user_id) then
    return 'kept';
  end if;
  delete from public.email_login_codes where email = (select lower(email) from public.users where id = p_user_id);
  update public.users set email = 'erased+' || p_user_id::text || '@erased.invalid',
    password_hash = null, google_subject = null, display_name = null, updated_at = now()
    where id = p_user_id;
  delete from public.sessions where user_id = p_user_id;
  delete from public.native_auth_codes where user_id = p_user_id;
  delete from public.mobile_connect_tickets where user_id = p_user_id;
  delete from public.push_subscriptions where user_id = p_user_id;
  delete from public.apns_devices where user_id = p_user_id;
  return 'pseudonymized';
end;
$$;

-- comment: FUNCTION erase_account_user(p_user_id uuid)
COMMENT ON FUNCTION public.erase_account_user(p_user_id uuid) IS 'Account purge: deletes a user without any membership, pseudonymizes one that only keeps revoked memberships (history of other tenants), keeps one with a live membership. openedbot_worker only.';

-- function: finalize_account_closure(uuid)
CREATE FUNCTION public.finalize_account_closure(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare job public.account_deletions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.organizations o where exists (
    select 1 from public.memberships m where m.organization_id = o.id
      and m.user_id = p_user_id and m.revoked_at is null
  ) order by o.id for no key update;
  perform public.lock_account_closure_user(p_user_id);
  select * into job from public.account_deletions where user_id = p_user_id for update;
  if not found or job.purge_after > now() then return false; end if;
  if exists (select 1 from public.organizations where id = any(job.organization_ids)) then return false; end if;
  if exists (select 1 from public.memberships m where m.user_id = p_user_id and m.revoked_at is null
    and m.role = 'owner' and not exists (
      select 1 from public.memberships other where other.organization_id = m.organization_id
        and other.user_id <> p_user_id and other.role = 'owner' and other.revoked_at is null
    )) then raise exception 'ACCOUNT_DELETION_TRANSFER_REQUIRED'; end if;
  update public.memberships set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  delete from public.account_deletions where user_id = p_user_id;
  if public.erase_account_user(p_user_id) <> 'pseudonymized' then
    raise exception 'Account closure did not erase identity';
  end if;
  return true;
end;
$$;

-- function: guard_closing_account_membership()
CREATE FUNCTION public.guard_closing_account_membership() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if new.revoked_at is null then
    -- Match invitation acceptance: serialize with the scheduler's member count.
    perform 1 from public.organizations where id = new.organization_id for no key update;
    -- No newly shared tenant can slip into an already confirmed solo purge.
    if exists (select 1 from public.tenant_deletions where organization_id = new.organization_id and reason = 'account_deleted') then
      raise exception 'Workspace account deletion pending' using errcode = '23514';
    end if;
    perform 1 from public.users where id = new.user_id for update;
    if exists (select 1 from public.account_deletions where user_id = new.user_id)
      or exists (select 1 from public.users where id = new.user_id and email = 'erased+' || new.user_id::text || '@erased.invalid') then
      raise exception 'Account closure pending; cancel it before changing memberships' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- function: guard_erased_account_credentials()
CREATE FUNCTION public.guard_erased_account_credentials() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if old.email = 'erased+' || old.id::text || '@erased.invalid'
    and (new.email, new.password_hash, new.google_subject) is distinct from (old.email, old.password_hash, old.google_subject) then
    raise exception 'Account is closed' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- function: guard_erased_account_session()
CREATE FUNCTION public.guard_erased_account_session() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  perform 1 from public.users where id = new.user_id for update;
  if exists (select 1 from public.users where id = new.user_id and email = 'erased+' || new.user_id::text || '@erased.invalid') then
    raise exception 'Account is closed' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- function: guard_run_final_status()
CREATE FUNCTION public.guard_run_final_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'run % is % and cannot become %', old.id, old.status, new.status
    using errcode = '23514', constraint = 'runs_final_status';
end;
$$;

-- function: internal_email_delivery_metrics()
CREATE FUNCTION public.internal_email_delivery_metrics() RETURNS TABLE(pending_login_codes bigint, oldest_login_code_age_seconds double precision, recent_login_code_failures bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select count(*),
         coalesce(greatest(0, extract(epoch from now() - min(created_at))), 0)::double precision,
         -- One message counts once, even after several retries and a failure.
         (select count(*) from public.email_outbox
           where kind in ('email_login_code', 'staff_login_code')
             and last_delivery_failure_at >= now() - interval '10 minutes')
    from public.email_outbox
   where kind in ('email_login_code', 'staff_login_code')
     and status in ('pending', 'sending');
$$;

-- function: internal_operational_metrics()
CREATE FUNCTION public.internal_operational_metrics() RETURNS TABLE(run_status_counts jsonb, run_external_state_counts jsonb, workflow_status_counts jsonb, queued_runs bigint, oldest_queued_seconds double precision, needs_review_runs bigint, oldest_unknown_seconds double precision, active_workflows bigint, unknown_workflows bigint, overdue_workflows bigint, pending_approvals bigint, expired_pending_approvals bigint, oldest_pending_approval_seconds double precision, relaying_runs bigint, oldest_relaying_seconds double precision, active_run_leases bigint, expired_run_leases bigint, missing_run_leases bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

-- function: lock_account_closure_user(uuid)
CREATE FUNCTION public.lock_account_closure_user(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text), hashtext('openedbot-user-sessions'));
  perform 1 from public.users where id = p_user_id for update;
end;
$$;

-- function: notify_openedbot_event()
CREATE FUNCTION public.notify_openedbot_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform pg_notify('openedbot_events', new.organization_id::text || ':' || new.cursor::text);
  return new;
end;
$$;

-- function: notify_openedbot_runtime()
CREATE FUNCTION public.notify_openedbot_runtime() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    perform pg_catalog.pg_notify('openedbot_runtime', old.organization_id::text || ':' || old.id::text);
  else
    perform pg_catalog.pg_notify('openedbot_runtime', new.organization_id::text || ':' || new.id::text);
  end if;
  return null;
end;
$$;

-- function: notify_openedbot_runtime_child()
CREATE FUNCTION public.notify_openedbot_runtime_child() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    perform pg_catalog.pg_notify('openedbot_runtime', old.organization_id::text || ':' || old.runtime_id::text);
  else
    perform pg_catalog.pg_notify('openedbot_runtime', new.organization_id::text || ':' || new.runtime_id::text);
  end if;
  return null;
end;
$$;

-- function: notify_worker_run_queue()
CREATE FUNCTION public.notify_worker_run_queue() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'queued' then
      perform pg_catalog.pg_notify('openedbot_run_queue_v1', '');
    end if;
  elsif (new.status = 'queued' and
      (old.status is distinct from new.status or old.next_attempt_at is distinct from new.next_attempt_at
        or old.remote_stop_state is distinct from new.remote_stop_state))
    or (old.status in ('starting', 'running', 'awaiting_approval', 'relaying', 'unknown') and
      (new.status not in ('starting', 'running', 'awaiting_approval', 'relaying', 'unknown')
        or (old.lease_owner is not null and new.lease_owner is null))) then
    perform pg_catalog.pg_notify('openedbot_run_queue_v1', '');
  end if;
  return new;
end;
$$;

-- function: open_unknown_run_review_workflow()
CREATE FUNCTION public.open_unknown_run_review_workflow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  review_id uuid;
  review_kind text;
begin
  if new.status is distinct from 'unknown' or old.status = 'unknown'
     or new.workflow_id is not null then
    return new;
  end if;
  select case when thread.group_id is null then 'dm' else 'group' end
    into review_kind
    from public.threads thread
   where thread.organization_id = new.organization_id and thread.id = new.thread_id;
  review_id := gen_random_uuid();
  insert into public.workflows (
    id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id,
    kind, status, timeout_seconds, used_steps, deadline_at,
    error_code, error_message, created_at, started_at, updated_at
  ) values (
    review_id, new.organization_id, new.thread_id, new.id, new.bot_id, new.initiator_user_id,
    coalesce(review_kind, 'dm'), 'unknown',
    least(3600, greatest(60, coalesce(extract(epoch from (new.deadline_at - new.created_at))::integer, 1800))),
    1, coalesce(new.deadline_at, now()),
    new.error_code, new.error_message, new.created_at, coalesce(new.started_at, now()), now()
  );
  new.workflow_id := review_id;
  return new;
end;
$$;

-- function: openedbot_global_search_normalize(text)
CREATE FUNCTION public.openedbot_global_search_normalize(input text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select translate(
    regexp_replace(
      normalize(
        replace(replace(
          replace(replace(
            replace(replace(
              replace(replace(
                replace(replace(
                  replace(replace(
                    replace(replace(input, 'Œ', 'oe'), 'œ', 'oe'),
                    'Æ', 'ae'), 'æ', 'ae'),
                  'ẞ', 'ss'), 'ß', 'ss'),
                'Þ', 'th'), 'þ', 'th'),
              'Ø', 'o'), 'ø', 'o'),
            'Ł', 'l'), 'ł', 'l'),
          'Đ', 'd'), 'đ', 'd'),
        NFKD
      ) collate "C",
      U&'[\0300-\036f]' collate "C",
      '',
      'g'
    ),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZÐð',
    'abcdefghijklmnopqrstuvwxyzdd'
  )
$$;

-- function: openedbot_visible_message_search_text(jsonb)
CREATE FUNCTION public.openedbot_visible_message_search_text(content jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select public.openedbot_global_search_normalize(coalesce(string_agg(
    case
      when part.value->>'type' = 'text' then coalesce(part.value->>'text', '')
      when part.value->>'type' = 'attachment' then coalesce(part.value->>'name', '')
      else null
    end,
    E'\n' order by part.ordinality
  ), ''))
  from jsonb_array_elements(
    case when jsonb_typeof(content) = 'array' then content else '[]'::jsonb end
  ) with ordinality as part(value, ordinality)
$$;

-- function: organization_permission_policies_revision()
CREATE FUNCTION public.organization_permission_policies_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.organization_id;
  return new;
end;
$$;

-- function: organizations_permission_pipeline_revision()
CREATE FUNCTION public.organizations_permission_pipeline_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.id;
  return new;
end;
$$;

-- function: permission_command_blocklist_valid(text[])
CREATE FUNCTION public.permission_command_blocklist_valid(entries text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'pg_catalog'
    AS $_$
  select entries is not null
     and coalesce(array_length(entries, 1), 0) <= 50
     and array_position(entries, null) is null
     and (select count(*) = count(distinct e) from unnest(entries) e)
     and not exists (
       select 1 from unnest(entries) e
        where char_length(e) not between 1 and 120
           or e !~ '^[A-Za-z0-9._+-]+( [A-Za-z0-9._/:=,+@%~-]+)*$'
           or split_part(e, ' ', 1) in ('sudo', 'command')
     );
$_$;

-- function: purge_dead_sessions()
CREATE FUNCTION public.purge_dead_sessions() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  with deleted as (
    delete from public.sessions
     where coalesce(refresh_expires_at, access_expires_at) < pg_catalog.now() - interval '30 days'
       and (revoked_at is null or revoked_at < pg_catalog.now() - interval '30 days')
     returning 1
  )
  select pg_catalog.count(*) from deleted;
$$;

-- comment: FUNCTION purge_dead_sessions()
COMMENT ON FUNCTION public.purge_dead_sessions() IS 'Deletes sessions expired, and if revoked revoked, for more than thirty days; returns the count. openedbot_worker only.';

-- function: purge_expired_oauth_attempts()
CREATE FUNCTION public.purge_expired_oauth_attempts() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  with deleted as (
    delete from public.oauth_attempts where expires_at <= now() returning 1
  )
  select count(*)::bigint from deleted;
$$;

-- function: purge_spent_email_login_codes()
CREATE FUNCTION public.purge_spent_email_login_codes() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  with deleted as (
    delete from public.email_login_codes
     where expires_at < pg_catalog.now() - interval '1 day'
     returning 1
  )
  select pg_catalog.count(*) from deleted;
$$;

-- comment: FUNCTION purge_spent_email_login_codes()
COMMENT ON FUNCTION public.purge_spent_email_login_codes() IS 'Deletes e-mail login codes expired for more than one day; returns the count. openedbot_worker only.';

-- function: reassign_push_endpoint()
CREATE FUNCTION public.reassign_push_endpoint() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  delete from public.push_subscriptions
   where endpoint = new.endpoint and id <> new.id;
  return new;
end;
$$;

-- function: record_workspace_activation()
CREATE FUNCTION public.record_workspace_activation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
declare m boolean := false; v boolean := false; b boolean := false; r boolean := false;
begin
  if tg_table_name = 'runtimes' then m := new.link_last_seen_at is not null;
  elsif tg_table_name = 'runtime_model_proven' then v := true;
  elsif tg_table_name = 'bot_profile_provisions' then b := new.status = 'succeeded';
  elsif tg_table_name = 'workflows' then
    r := new.status = 'completed' and new.kind <> 'routine' and new.initiator_user_id is not null
      and exists(select 1 from public.runs where id=new.root_run_id and origin is null
        and length(trim(coalesce(new.final_output,output)))>0);
    b := r; v := r;
  end if;
  insert into public.workspace_activation(organization_id,machine,model,bot,result)
    values(new.organization_id,m,v,b,r)
    on conflict(organization_id) do update set
      machine = workspace_activation.machine or excluded.machine,
      model = workspace_activation.model or excluded.model,
      bot = workspace_activation.bot or excluded.bot,
      result = workspace_activation.result or excluded.result
    where (excluded.machine and not workspace_activation.machine) or (excluded.model and not workspace_activation.model)
      or (excluded.bot and not workspace_activation.bot) or (excluded.result and not workspace_activation.result);
  return new;
end; $$;

-- function: revoke_moved_apns_token()
CREATE FUNCTION public.revoke_moved_apns_token() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.revoked_at is null then
    update public.apns_devices
       set revoked_at = now(), revoked_reason = 'token_moved',
           token_ciphertext = null, token_nonce = null, token_tag = null,
           token_key_id = null, updated_at = now()
     where token_hash = new.token_hash and id <> new.id and revoked_at is null;
  end if;
  return new;
end;
$$;

-- function: routine_tool_due_organizations(integer)
CREATE FUNCTION public.routine_tool_due_organizations(max_count integer) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select rt.organization_id
    from public.runtimes rt
   where rt.is_active and rt.revoked_at is null and rt.reachability = 'connector'
     and rt.link_last_seen_at > now() - interval '45 seconds'
     and (
       exists (
         select 1
           from public.bots b
           left join public.bot_profile_provisions p on p.organization_id = b.organization_id and p.bot_id = b.id
           left join public.bot_routine_tools t on t.organization_id = b.organization_id and t.bot_id = b.id
          where b.organization_id = rt.organization_id
            and b.deleted_at is null and b.archived_at is null and b.host_profile_deleting_at is null
            and (p.status is null or p.status = 'succeeded')
            and (t.next_attempt_at is null or t.next_attempt_at <= now())
            and (
              (not coalesce(t.switched_off, false) and (t.enabled_at is null or t.runtime_id is distinct from rt.id))
              or (t.switched_off and b.hermes_profile is not null and (t.disabled_at is null or t.runtime_id is distinct from rt.id))
              or (t.restart_pending_since is not null and t.runtime_id = rt.id)
            )
       )
       or exists (
         select 1 from public.runtime_routine_tools r
          where r.organization_id = rt.organization_id and r.runtime_id = rt.id and r.installed_at is not null
            and (r.verified_at is null or r.verified_at < now() - interval '30 minutes'
              or r.auth_failed_at > coalesce(r.verified_at, '-infinity'::timestamptz))
       )
     )
   order by rt.organization_id
   limit greatest(1, least(max_count, 100))
$$;

-- function: run_events_stamp_identity()
CREATE FUNCTION public.run_events_stamp_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  current_run record;
begin
  if new.lease_generation is null then
    select run.bot_id, run.lease_generation,
           coalesce(workflow.root_run_id, run.id) as turn_id,
           coalesce(run.execution_session_key, thread.hermes_session_id) as session_key
      into current_run
      from runs run
      left join workflows workflow
        on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
      left join threads thread
        on thread.organization_id = run.organization_id and thread.id = run.thread_id
     where run.organization_id = new.organization_id and run.id = new.run_id;
  else
    select run.bot_id, run.lease_generation,
           coalesce(workflow.root_run_id, run.id) as turn_id,
           coalesce(run.execution_session_key, thread.hermes_session_id) as session_key
      into current_run
      from runs run
      left join workflows workflow
        on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
      left join threads thread
        on thread.organization_id = run.organization_id and thread.id = run.thread_id
     where run.organization_id = new.organization_id and run.id = new.run_id
       for share of run;
  end if;
  -- Run introuvable : la FK run_events -> runs refuse la ligne juste après.
  if not found then
    return new;
  end if;
  if new.lease_generation is not null and new.lease_generation <> current_run.lease_generation then
    raise exception 'run % event written under lease generation %, current is %',
      new.run_id, new.lease_generation, current_run.lease_generation
      using errcode = '23514', constraint = 'run_events_lease_fence';
  end if;
  new.bot_id := current_run.bot_id;
  new.turn_id := current_run.turn_id;
  new.session_key := current_run.session_key;
  new.lease_generation := current_run.lease_generation;
  return new;
end;
$$;

-- function: runtime_link_owner(uuid)
CREATE FUNCTION public.runtime_link_owner(p_runtime_id uuid) RETURNS TABLE(instance_id text, internal_url text, instance_live boolean, link_last_seen_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select
    r.link_instance_id,
    i.internal_url,
    (
      i.instance_id is not null
      and i.stopped_at is null
      and i.last_seen_at > now() - interval '60 seconds'
    ) as instance_live,
    r.link_last_seen_at
    from public.runtimes r
    left join public.api_instances i on i.instance_id = r.link_instance_id
   where r.id = p_runtime_id
     and r.reachability = 'connector'
     and r.revoked_at is null;
$$;

-- comment: FUNCTION runtime_link_owner(p_runtime_id uuid)
COMMENT ON FUNCTION public.runtime_link_owner(p_runtime_id uuid) IS 'Instance qui tient le lien connecteur de ce runtime, et si elle est vivante (heartbeat < 60 s, pas d''arrêt propre). Traverse la RLS de runtimes : le relais interne n''a pas de tenant. Ne rend aucune donnée d''organisation.';

-- function: runtime_permission_settings_revision()
CREATE FUNCTION public.runtime_permission_settings_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform 1 from public.bots where organization_id = new.organization_id order by id for update;
  update public.bots set permission_revision = permission_revision + 1 where organization_id = new.organization_id;
  return new;
end;
$$;

-- function: set_organization_permission_policy(uuid, uuid, text, boolean, text, text[], bigint)
CREATE FUNCTION public.set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint) RETURNS TABLE(status text, version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  tenant uuid;
  pipeline text;
  current_version bigint;
  changed boolean;
begin
  begin
    tenant := nullif(current_setting('app.organization_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      tenant := null;
  end;
  if tenant is null or tenant is distinct from p_organization_id then
    raise exception 'organization context mismatch' using errcode = '42501', hint = 'TENANT_MISMATCH';
  end if;
  select o.permission_pipeline into pipeline
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if pipeline is null then
    raise exception 'organization not found' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.organization_id = p_organization_id and m.user_id = p_actor_user_id
       and m.revoked_at is null and m.role in ('owner', 'admin')
  ) then
    raise exception 'owner or admin required' using errcode = '42501', hint = 'ROLE_REQUIRED';
  end if;
  if p_enforce_review is null or p_rules_mode is null or p_command_blocklist is null then
    raise exception 'incomplete permission policy' using errcode = '22023';
  end if;

  select p.version into current_version
    from public.organization_permission_policies p
   where p.organization_id = p_organization_id
   for update;
  if coalesce(current_version, 0) is distinct from coalesce(p_expected_version, 0) then
    return query select 'conflict'::text, coalesce(current_version, 0);
    return;
  end if;
  if pipeline is distinct from 'v2' then
    return query select 'pipeline_legacy'::text, coalesce(current_version, 0);
    return;
  end if;

  if current_version is null then
    insert into public.organization_permission_policies
      (organization_id, max_mode, enforce_review, rules_mode, command_blocklist, version, updated_by_user_id)
    values (p_organization_id, p_max_mode, p_enforce_review, p_rules_mode, p_command_blocklist, 1, p_actor_user_id);
    return query select 'saved'::text, 1::bigint;
    return;
  end if;

  select p.max_mode is distinct from p_max_mode
      or p.enforce_review is distinct from p_enforce_review
      or p.rules_mode is distinct from p_rules_mode
      or p.command_blocklist is distinct from p_command_blocklist
    into changed
    from public.organization_permission_policies p
   where p.organization_id = p_organization_id;
  if not changed then
    return query select 'unchanged'::text, current_version;
    return;
  end if;
  update public.organization_permission_policies p
     set max_mode = p_max_mode, enforce_review = p_enforce_review, rules_mode = p_rules_mode,
         command_blocklist = p_command_blocklist, version = current_version + 1,
         updated_by_user_id = p_actor_user_id, updated_at = now()
   where p.organization_id = p_organization_id;
  return query select 'saved'::text, current_version + 1;
end;
$$;

-- comment: FUNCTION set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint)
COMMENT ON FUNCTION public.set_organization_permission_policy(p_organization_id uuid, p_actor_user_id uuid, p_max_mode text, p_enforce_review boolean, p_rules_mode text, p_command_blocklist text[], p_expected_version bigint) IS 'PERM2-8: the only write of organization_permission_policies. Requires app.organization_id = p_organization_id and a live owner or admin membership of p_actor_user_id (agencies refused, D-5). Answers saved, unchanged, conflict (stale p_expected_version) or pipeline_legacy.';

-- function: staff_acknowledge_runtime_link_alert(uuid)
CREATE FUNCTION public.staff_acknowledge_runtime_link_alert(p_alert uuid) RETURNS TABLE(acknowledged_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  -- Idempotent : le premier acquittement garde sa date et son auteur.
  return query
    update public.runtime_link_alerts a
       set acknowledged_at = coalesce(a.acknowledged_at, now()),
           acknowledged_by = coalesce(a.acknowledged_by, staff_id)
     where a.id = p_alert
     returning a.acknowledged_at;
end;
$$;

-- comment: FUNCTION staff_acknowledge_runtime_link_alert(p_alert uuid)
COMMENT ON FUNCTION public.staff_acknowledge_runtime_link_alert(p_alert uuid) IS 'Acquitte une alerte de lien connecteur au nom du staff courant. Aucune ligne rendue : alerte inconnue.';

-- function: staff_audit_log(integer, timestamp with time zone)
CREATE FUNCTION public.staff_audit_log(p_limit integer DEFAULT 200, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(occurred_at timestamp with time zone, organization_id uuid, source text, action text, actor_kind text, actor_id uuid, subject_kind text, subject_id uuid, details jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query
    select
      a.occurred_at,
      a.organization_id,
      a.source,
      a.action,
      a.actor_kind,
      a.actor_id,
      a.subject_kind,
      a.subject_id,
      a.details
      from public.audit_log a
     where p_before is null or a.occurred_at < p_before
     order by a.occurred_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

-- comment: FUNCTION staff_audit_log(p_limit integer, p_before timestamp with time zone)
COMMENT ON FUNCTION public.staff_audit_log(p_limit integer, p_before timestamp with time zone) IS 'Journal d''audit unifié servi au backoffice staff, les plus récents d''abord. Pagination par curseur temporel : `p_before` reprend le `occurred_at` de la dernière ligne rendue. `p_limit` est borné à 1000.';

-- function: staff_audit_scope(uuid, uuid, integer, timestamp with time zone)
CREATE FUNCTION public.staff_audit_scope(p_organization_id uuid DEFAULT NULL::uuid, p_subject_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(occurred_at timestamp with time zone, organization_id uuid, source text, action text, actor_kind text, actor_id uuid, subject_kind text, subject_id uuid, details jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;
  if p_organization_id is null and p_subject_id is null then
    raise exception 'staff audit scope required' using errcode = '22023';
  end if;

  return query
    select
      a.occurred_at,
      a.organization_id,
      a.source,
      a.action,
      a.actor_kind,
      a.actor_id,
      a.subject_kind,
      a.subject_id,
      a.details
      from public.audit_log a
     where (p_organization_id is null or a.organization_id = p_organization_id)
       and (
         p_subject_id is null
         or a.subject_id = p_subject_id
         or a.actor_id = p_subject_id
       )
       and (p_before is null or a.occurred_at < p_before)
     order by a.occurred_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- comment: FUNCTION staff_audit_scope(p_organization_id uuid, p_subject_id uuid, p_limit integer, p_before timestamp with time zone)
COMMENT ON FUNCTION public.staff_audit_scope(p_organization_id uuid, p_subject_id uuid, p_limit integer, p_before timestamp with time zone) IS 'Journal d''audit cadré, servi au dossier support du backoffice staff : les lignes d''`audit_log` d''une organisation, d''un sujet (acteur ou sujet de la ligne), ou des deux. Même préambule de garde que `staff_audit_log()`, même vue source, aucune colonne de plus : ni contenu de message, ni titre de fil, ni jeton, ni condensat. Refuse `22023` sans cadre : le journal global est le travail de `staff_audit_log()`. Pagination par curseur temporel `p_before`, borne plafonnée à 500.';

-- function: staff_closure_notice_recipients(integer)
CREATE FUNCTION public.staff_closure_notice_recipients(p_limit integer DEFAULT 5000) RETURNS TABLE(id uuid, email text, display_name text, total_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  bounded_limit int;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  bounded_limit := least(greatest(coalesce(p_limit, 5000), 1), 20000);

  return query
  select u.id, u.email, u.display_name, count(*) over ()
    from public.users u
   order by u.created_at, u.id
   limit bounded_limit;
end;
$$;

-- comment: FUNCTION staff_closure_notice_recipients(p_limit integer)
COMMENT ON FUNCTION public.staff_closure_notice_recipients(p_limit integer) IS 'Tous les comptes (id, e-mail, nom) pour l''avis de fermeture du backoffice staff, en une lecture, borne plafonnee a 20000. Rend le total de la table : moins de lignes que ce total veut dire que la borne a coupe. Refuse (42501) sans staff actif.';

-- function: staff_get_organization(uuid)
CREATE FUNCTION public.staff_get_organization(p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  payload jsonb;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', o.id,
    'slug', o.slug,
    'name', o.name,
    'kind', o.kind,
    'createdAt', o.created_at,
    'deletedAt', o.deleted_at,
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'userId', u.id,
          'email', u.email,
          'displayName', u.display_name,
          'role', m.role
        )
        order by m.created_at
      )
      from public.memberships m
      join public.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'::jsonb),
    'agencyGrants', '[]'::jsonb,
    'subscription', (
      select jsonb_build_object(
        'status', s.status,
        'runtimeLimit', s.runtime_limit,
        'memberLimit', s.member_limit,
        'concurrentRunLimit', s.concurrent_run_limit,
        'attachmentQuotaBytes', s.attachment_quota_bytes,
        'currentPeriodEnd', s.current_period_end,
        'stripeCustomerId', s.stripe_customer_id
      )
      from public.subscriptions s
      where s.organization_id = o.id
    ),
    'runtimes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'name', r.name,
          'endpointHost', (regexp_match(r.endpoint, '^https?://([^/?#]+)'))[1],
          'health', r.last_health_status,
          'lastCheckedAt', r.last_probed_at
        )
        order by r.created_at
      )
      from public.runtimes r
      where r.organization_id = o.id
    ), '[]'::jsonb),
    'tenantDeletion', (
      select jsonb_build_object(
        'reason', d.reason,
        'requestedAt', d.requested_at,
        'purgeAfter', d.purge_after,
        'startedAt', d.started_at,
        'completedAt', d.completed_at
      )
      from public.tenant_deletions d
      where d.organization_id = o.id
    )
  )
  into payload
  from public.organizations o
  where o.id = p_id;

  return payload;
end;
$$;

-- function: staff_get_user(uuid)
CREATE FUNCTION public.staff_get_user(p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  payload jsonb;
  org_ids uuid[];
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  if not exists (select 1 from public.users u where u.id = p_id) then
    return null;
  end if;

  -- Périmètre du compte : les organisations dont il est membre. Tout ce qui
  -- suit (runtimes, totaux, activité) est borné par ce tableau.
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
    into org_ids
    from public.memberships m
   where m.user_id = p_id;

  select jsonb_build_object(
    'user', jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'displayName', u.display_name,
      'createdAt', u.created_at,
      -- Dernière ENTRÉE du compte, pas l'activité de ses sessions : les deux
      -- cohabitent sur la fiche et ne répondent pas à la même question.
      -- `null` = aucune connexion vue depuis 0075, jamais « jamais connecté ».
      'lastLoginAt', u.last_login_at,
      'onboardingCompleted', u.onboarding_completed,
      -- Même définition que `staff_search_users()` (0059_staff_user_paging.sql) :
      -- un accès encore actif sur une organisation non supprimée.
      'canImpersonate', exists (
        select 1
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
         where m.user_id = u.id
           and o.deleted_at is null
      )
    ),
    'organizations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', o.id,
          'slug', o.slug,
          'name', o.name,
          'kind', o.kind,
          'role', m.role,
          'joinedAt', m.created_at,
          'memberCount', (
            select count(*) from public.memberships m2 where m2.organization_id = o.id
          ),
          'botCount', (
            select count(*) from public.bots b
             where b.organization_id = o.id and b.deleted_at is null
          ),
          'subscriptionStatus', (
            select s.status from public.subscriptions s where s.organization_id = o.id
          ),
          'deletedAt', o.deleted_at
        )
        order by m.created_at
      )
      from public.memberships m
      join public.organizations o on o.id = m.organization_id
      where m.user_id = u.id
    ), '[]'::jsonb),
    'runtimes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'organizationId', r.organization_id,
          -- L'hôte seul, jamais l'URL complète ni un jeton.
          'endpointHost', (regexp_match(r.endpoint, '^https?://([^/?#]+)'))[1],
          'name', r.name,
          'health', r.last_health_status,
          'reachability', r.reachability,
          'isActive', r.is_active,
          'revokedAt', r.revoked_at,
          'linkConnectedAt', r.link_connected_at,
          'linkLastSeenAt', r.link_last_seen_at,
          'lastCheckedAt', r.last_probed_at
        )
        order by r.created_at
      )
      from public.runtimes r
      where r.organization_id = any(org_ids)
    ), '[]'::jsonb),
    'sessions', (
      select jsonb_build_object(
        -- « Active » = non révoquée et pas encore expirée.
        'active', count(*) filter (
          where s.revoked_at is null
            and greatest(s.access_expires_at, coalesce(s.refresh_expires_at, s.access_expires_at)) > now()
        ),
        'total', count(*),
        'lastSeenAt', max(s.last_seen_at),
        'recent', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', recent.id,
              'kind', recent.kind,
              'createdAt', recent.created_at,
              'lastSeenAt', recent.last_seen_at,
              'revokedAt', recent.revoked_at,
              'impersonated', recent.impersonated_by_staff_user_id is not null
            )
            order by recent.created_at desc
          )
          from (
            select s2.id, s2.kind, s2.created_at, s2.last_seen_at, s2.revoked_at,
                   s2.impersonated_by_staff_user_id
              from public.sessions s2
             where s2.user_id = u.id
             order by s2.created_at desc
             limit 10
          ) recent
        ), '[]'::jsonb)
      )
      from public.sessions s
      where s.user_id = u.id
    ),
    'assistance', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'createdAt', claim.created_at,
          'claimedAt', claim.claimed_at,
          'expiresAt', claim.expires_at,
          'organizationId', claim.organization_id,
          'staffUserId', claim.staff_user_id,
          'staffDisplayName', claim.staff_display_name,
          'staffEmail', claim.staff_email
        )
        order by claim.created_at desc
      )
      from (
        select c.created_at, c.claimed_at, c.expires_at, c.organization_id,
               c.staff_user_id, su.display_name as staff_display_name, su.email as staff_email
          from public.staff_impersonation_claims c
          join public.staff_users su on su.id = c.staff_user_id
         where c.user_id = u.id
         order by c.created_at desc
         limit 10
      ) claim
    ), '[]'::jsonb),
    -- ATTENTION : ceci est l'activité des ORGANISATIONS du compte, pas celle
    -- de l'utilisateur. `messages` ne porte que `role` / `author_bot_id` et
    -- `runs` n'a ni `user_id` ni `created_by` : aucune ligne n'est attribuable
    -- à un membre précis. Une organisation à plusieurs membres agrège donc le
    -- travail de tous. Ne pas renommer ce champ en « activité utilisateur ».
    'organizationActivity', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'day', to_char(d.day, 'YYYY-MM-DD'),
          'messages', a.messages,
          'runs', a.runs,
          'threads', a.threads
        )
        order by d.day
      )
      from (
        select gs::date as day
          from generate_series(current_date - 29, current_date, interval '1 day') gs
      ) d
      cross join lateral (
        select
          (select count(*) from public.messages msg
            where msg.organization_id = any(org_ids)
              and msg.created_at >= d.day::timestamptz
              and msg.created_at < (d.day + 1)::timestamptz) as messages,
          (select count(*) from public.runs rn
            where rn.organization_id = any(org_ids)
              and rn.created_at >= d.day::timestamptz
              and rn.created_at < (d.day + 1)::timestamptz) as runs,
          (select count(*) from public.threads th
            where th.organization_id = any(org_ids)
              and th.created_at >= d.day::timestamptz
              and th.created_at < (d.day + 1)::timestamptz) as threads
      ) a
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'organizations', coalesce(array_length(org_ids, 1), 0),
      'runtimes', (select count(*) from public.runtimes r where r.organization_id = any(org_ids)),
      'bots', (
        select count(*) from public.bots b
         where b.organization_id = any(org_ids) and b.deleted_at is null
      ),
      'threads', (select count(*) from public.threads t where t.organization_id = any(org_ids)),
      'messages', (select count(*) from public.messages m3 where m3.organization_id = any(org_ids)),
      'runs', (select count(*) from public.runs r2 where r2.organization_id = any(org_ids))
    )
  )
  into payload
  from public.users u
  where u.id = p_id;

  return payload;
end;
$$;

-- comment: FUNCTION staff_get_user(p_id uuid)
COMMENT ON FUNCTION public.staff_get_user(p_id uuid) IS 'Fiche staff d''un compte utilisateur. Rend la dernière connexion du compte (users.last_login_at), distincte de l''activité de ses sessions. `organizationActivity` agrège les organisations du compte : `messages` et `runs` ne portent aucun auteur utilisateur, l''activité n''est donc PAS attribuable à un membre précis. N''expose ni secret runtime, ni ip / user-agent / hash de jeton de session, ni hash de code d''assistance.';

-- function: staff_issue_impersonation_claim(uuid, uuid, uuid, text, timestamp with time zone)
CREATE FUNCTION public.staff_issue_impersonation_claim(p_id uuid, p_organization_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  target_email text;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  select u.email
    into target_email
    from public.organizations o
    join public.memberships m on m.organization_id = o.id
    join public.users u on u.id = m.user_id
   where o.id = p_organization_id
     and o.deleted_at is null
     and m.user_id = p_user_id;

  if target_email is null then
    return null;
  end if;

  insert into public.staff_impersonation_claims (
    id, staff_user_id, organization_id, user_id, claim_token_hash, expires_at
  ) values (
    p_id, staff_id, p_organization_id, p_user_id, p_claim_token_hash, p_expires_at
  );

  return target_email;
end;
$$;

-- function: staff_issue_user_impersonation_claim(uuid, uuid, text, timestamp with time zone)
CREATE FUNCTION public.staff_issue_user_impersonation_claim(p_id uuid, p_user_id uuid, p_claim_token_hash text, p_expires_at timestamp with time zone) RETURNS TABLE(email text, organization_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  target_email text;
  target_organization_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  select u.email, m.organization_id
    into target_email, target_organization_id
    from public.users u
    join public.memberships m on m.user_id = u.id
    join public.organizations o on o.id = m.organization_id
   where u.id = p_user_id
     and o.deleted_at is null
   order by m.created_at asc, m.organization_id asc
   limit 1;

  if target_email is null or target_organization_id is null then
    return;
  end if;

  insert into public.staff_impersonation_claims (
    id, staff_user_id, organization_id, user_id, claim_token_hash, expires_at
  ) values (
    p_id, staff_id, target_organization_id, p_user_id, p_claim_token_hash, p_expires_at
  );

  return query select target_email, target_organization_id;
end;
$$;

-- function: staff_operational_metrics()
CREATE FUNCTION public.staff_operational_metrics() RETURNS TABLE(run_status_counts jsonb, run_external_state_counts jsonb, workflow_status_counts jsonb, queued_runs bigint, oldest_queued_seconds double precision, needs_review_runs bigint, oldest_unknown_seconds double precision, active_workflows bigint, unknown_workflows bigint, overdue_workflows bigint, pending_approvals bigint, expired_pending_approvals bigint, oldest_pending_approval_seconds double precision, relaying_runs bigint, oldest_relaying_seconds double precision, active_run_leases bigint, expired_run_leases bigint, missing_run_leases bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query select * from public.internal_operational_metrics();
end;
$$;

-- function: staff_permission_bots(integer)
CREATE FUNCTION public.staff_permission_bots(p_limit integer DEFAULT 2000) RETURNS TABLE(bot_id uuid, bot_name text, organization_id uuid, organization_name text, organization_slug text, pipeline text, permission_mode text, approval_policy_mode text, approval_policy_effective_at timestamp with time zone, expected_policy_mode text, max_mode text, enforce_review boolean, in_bypass boolean, policy_not_effective boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  return query
    with candidates as (
      select b.id as bot_id, b.name as bot_name, o.id as organization_id, o.name as organization_name,
             o.slug as organization_slug, o.permission_pipeline as pipeline, b.permission_mode,
             b.approval_policy_mode, b.approval_policy_effective_at,
             case when o.permission_pipeline = 'v2'
               then case when b.permission_mode = 'plan' then 'block_writes' else 'ask_writes' end
             end as expected_policy_mode,
             p.max_mode, coalesce(p.enforce_review, false) as enforce_review
        from public.bots b
        join public.organizations o on o.id = b.organization_id
        left join public.organization_permission_policies p on p.organization_id = o.id
       where o.deleted_at is null
         and b.deleted_at is null
         and b.archived_at is null
    )
    select c.bot_id, c.bot_name, c.organization_id, c.organization_name, c.organization_slug,
           c.pipeline, c.permission_mode, c.approval_policy_mode, c.approval_policy_effective_at,
           c.expected_policy_mode, c.max_mode, c.enforce_review,
           c.permission_mode = 'bypass',
           c.pipeline = 'v2' and (
             c.approval_policy_effective_at is null
             or c.approval_policy_mode is distinct from c.expected_policy_mode
           )
      from candidates c
     where c.permission_mode = 'bypass'
        or (c.pipeline = 'v2' and (
              c.approval_policy_effective_at is null
              or c.approval_policy_mode is distinct from c.expected_policy_mode
            ))
     order by c.organization_name, c.bot_name, c.bot_id
     limit greatest(1, least(coalesce(p_limit, 2000), 2000));
end;
$$;

-- comment: FUNCTION staff_permission_bots(p_limit integer)
COMMENT ON FUNCTION public.staff_permission_bots(p_limit integer) IS 'PERM2-11: live bots in bypass, or whose host policy is not proven effective under v2 (PERM2-2), with the organization ceiling. Staff read only, p_limit bounded to 2000.';

-- function: staff_permission_decision_stats(integer)
CREATE FUNCTION public.staff_permission_decision_stats(p_days integer DEFAULT 7) RETURNS TABLE(pipeline text, decision_stage text, decided_by text, outcome text, gate_kind text, gates bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  return query
    select case when a.decision_state is null then 'legacy' else 'v2' end,
           a.decision_stage,
           case
             when a.decision_state is not null then a.decided_by_kind
             when a.resolved_by_policy is not null then 'policy'
             when a.resolved_by is not null then 'member'
             else null
           end,
           case
             when a.status = 'expired' then 'expired'
             when a.selected_choice is not null then a.selected_choice
             when a.decision_state = 'reviewing' then 'reviewing'
             else 'pending'
           end,
           a.gate_kind,
           count(*)
      from public.approval_requests a
      join public.organizations o on o.id = a.organization_id
     where o.deleted_at is null
       and a.created_at >= now() - (greatest(1, least(coalesce(p_days, 7), 90)) * interval '1 day')
     group by 1, 2, 3, 4, 5
     order by 6 desc, 1, 2, 3, 4, 5;
end;
$$;

-- comment: FUNCTION staff_permission_decision_stats(p_days integer)
COMMENT ON FUNCTION public.staff_permission_decision_stats(p_days integer) IS 'PERM2-11: gates of the last p_days days (1 to 90) counted by pipeline, stage, decider, outcome and gate kind. Staff read only, no gate text.';

-- function: staff_permission_decisions(text, integer, timestamp with time zone)
CREATE FUNCTION public.staff_permission_decisions(p_stage text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id uuid, created_at timestamp with time zone, resolved_at timestamp with time zone, organization_id uuid, organization_name text, organization_slug text, bot_id uuid, bot_name text, pipeline text, gate_kind text, tool_key text, decision_state text, decision_stage text, decided_by text, outcome text, resolved_by_policy text, resolver_user_id uuid, resolver_email text, resolver_name text, permission_revision_seen bigint, detail jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
begin
  perform public.staff_permission_guard();
  if p_stage is not null and p_stage not in (
    'legacy', 'forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human', 'unattended'
  ) then
    raise exception 'unknown permission decision stage' using errcode = '22023';
  end if;
  return query
    select a.id, a.created_at, a.resolved_at,
           o.id, o.name, o.slug,
           b.id, b.name,
           case when a.decision_state is null then 'legacy' else 'v2' end,
           a.gate_kind, a.tool_key, a.decision_state, a.decision_stage,
           case
             when a.decision_state is not null then a.decided_by_kind
             when a.resolved_by_policy is not null then 'policy'
             when a.resolved_by is not null then 'member'
             else null
           end,
           case
             when a.status = 'expired' then 'expired'
             when a.selected_choice is not null then a.selected_choice
             when a.decision_state = 'reviewing' then 'reviewing'
             else 'pending'
           end,
           a.resolved_by_policy,
           u.id, u.email, u.display_name,
           a.permission_revision_seen,
           jsonb_strip_nulls(jsonb_build_object(
             'reason', a.decision_detail -> 'reason',
             'effectiveMode', a.decision_detail -> 'effectiveMode',
             'always', a.decision_detail -> 'always',
             'grantError', a.decision_detail -> 'grantError',
             'humanOverridden', a.decision_detail -> 'humanOverridden',
             'redecided', a.decision_detail -> 'redecided',
             'policyChanged', a.decision_detail -> 'policyChanged',
             'durationMs', a.decision_detail -> 'durationMs'
           ))
      from public.approval_requests a
      join public.organizations o on o.id = a.organization_id
      left join public.runs r on r.organization_id = a.organization_id and r.id = a.run_id
      left join public.threads t on t.organization_id = a.organization_id and t.id = a.thread_id
      left join public.bots b on b.organization_id = a.organization_id and b.id = coalesce(r.bot_id, t.bot_id)
      left join public.users u on u.id = a.resolved_by
     where o.deleted_at is null
       and (p_before is null or a.created_at < p_before)
       and (
         p_stage is null
         or (p_stage = 'legacy' and a.decision_state is null)
         or (p_stage <> 'legacy' and a.decision_stage = p_stage)
       )
     order by a.created_at desc, a.id desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- comment: FUNCTION staff_permission_decisions(p_stage text, p_limit integer, p_before timestamp with time zone)
COMMENT ON FUNCTION public.staff_permission_decisions(p_stage text, p_limit integer, p_before timestamp with time zone) IS 'PERM2-11: latest gates, filtered by stage (or legacy), with who or what decided and the reason codes of decision_detail only. Staff read only, p_limit bounded to 500.';

-- function: staff_permission_guard()
CREATE FUNCTION public.staff_permission_guard() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null or not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
end;
$$;

-- function: staff_reset_user_password(uuid, text)
CREATE FUNCTION public.staff_reset_user_password(p_user_id uuid, p_password_hash text) RETURNS TABLE(status text, email text, organization_id uuid, revoked_sessions integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  target_email text;
  target_has_password boolean;
  target_has_google boolean;
  living_organization_id uuid;
  closed_sessions integer := 0;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  -- Le hachage vient de l'API (argon2id). Un paramètre vide ou trop court ne
  -- peut pas en être un : l'écrire condamnerait le compte à ne plus jamais
  -- pouvoir se connecter, et la ligne serait indiscernable d'un vrai hachage.
  if p_password_hash is null or length(p_password_hash) < 32 then
    raise exception 'a password hash is required' using errcode = '22023';
  end if;

  select u.email, (u.password_hash is not null), (u.google_subject is not null)
    into target_email, target_has_password, target_has_google
    from public.users u
   where u.id = p_user_id;

  -- Compte inconnu : AUCUNE ligne. L'API répond 404 et n'a rien à distinguer.
  if target_email is null then
    return;
  end if;

  if target_has_google and not target_has_password then
    return query select 'google_only'::text, target_email, null::uuid, 0;
    return;
  end if;

  select m.organization_id
    into living_organization_id
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = p_user_id
     and o.deleted_at is null
   order by m.created_at asc, m.organization_id asc
   limit 1;

  if living_organization_id is null then
    return query select 'no_organization'::text, target_email, null::uuid, 0;
    return;
  end if;

  update public.users
     set password_hash = p_password_hash,
         must_change_password = true,
         updated_at = now()
   where id = p_user_id;

  -- `password_change` est un motif déjà déclaré par la contrainte de 0019 :
  -- c'est bien ce qui vient de se passer, vu de la session fermée.
  with closed as (
    update public.sessions
       set revoked_at = now(), revoked_reason = 'password_change'
     where user_id = p_user_id and revoked_at is null
    returning 1
  )
  select count(*)::integer into closed_sessions from closed;

  return query select 'reset'::text, target_email, living_organization_id, closed_sessions;
end;
$$;

-- comment: FUNCTION staff_reset_user_password(p_user_id uuid, p_password_hash text)
COMMENT ON FUNCTION public.staff_reset_user_password(p_user_id uuid, p_password_hash text) IS 'Repose un mot de passe temporaire sur un compte existant, depuis le backoffice : nouveau hachage, drapeau must_change_password, et fermeture de toutes les sessions encore ouvertes, dans une seule transaction. Gardée par app.staff_user_id. Ne rend AUCUNE ligne pour un compte inconnu, et refuse sans rien écrire un compte qui n''entre que par Google (google_only) ou qui n''a plus d''espace vivant (no_organization).';

-- function: staff_resolve_reference(text)
CREATE FUNCTION public.staff_resolve_reference(p_term text) RETURNS TABLE(kind text, user_id uuid, label text, context text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  term text;
  as_uuid uuid;
  needle text;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  term := nullif(btrim(coalesce(p_term, '')), '');
  if term is null then
    return;
  end if;

  begin
    as_uuid := term::uuid;
  exception
    when invalid_text_representation then
      as_uuid := null;
  end;

  if as_uuid is not null then
    return query
    select 'user'::text,
           u.id,
           coalesce(nullif(btrim(u.display_name), ''), u.email),
           u.email
      from public.users u
     where u.id = as_uuid;

    return query
    select 'organization'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           o.name || ' (' || o.slug || ')'
      from public.organizations o
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where o.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return query
    select 'runtime'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, r.name),
           r.name || ' | ' || o.name
      from public.runtimes r
      join public.organizations o on o.id = r.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where r.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return query
    select 'run'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           'run ' || rn.status || ' | ' || o.name
      from public.runs rn
      join public.organizations o on o.id = rn.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where rn.id = as_uuid
     order by mu.email nulls first
     limit 10;

    -- Le fil ne sort que par son organisation : ni `title`, ni
    -- `hermes_session_id`, ni un compte de messages.
    return query
    select 'thread'::text,
           m.user_id,
           coalesce(nullif(btrim(mu.display_name), ''), mu.email, o.name),
           o.name
      from public.threads t
      join public.organizations o on o.id = t.organization_id
      left join public.memberships m on m.organization_id = o.id
      left join public.users mu on mu.id = m.user_id
     where t.id = as_uuid
     order by mu.email nulls first
     limit 10;

    return;
  end if;

  needle := '%' || replace(replace(replace(lower(term), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select 'user'::text,
         u.id,
         coalesce(nullif(btrim(u.display_name), ''), u.email),
         u.email
    from public.users u
   where lower(u.email) like needle escape '\'
      or lower(coalesce(u.display_name, '')) like needle escape '\'
   order by lower(u.email)
   limit 10;
end;
$$;

-- comment: FUNCTION staff_resolve_reference(p_term text)
COMMENT ON FUNCTION public.staff_resolve_reference(p_term text) IS 'Omnibox du backoffice staff : résout un e-mail, un fragment d''e-mail ou un identifiant de compte, d''organisation, de runtime, de run ou de fil vers le compte à ouvrir. Ne rend jamais de contenu de message ni de titre de fil. Aucun requestId : le log technique vit chez le collecteur, hors base.';

-- function: staff_runtime_connectors(integer)
CREATE FUNCTION public.staff_runtime_connectors(p_limit integer DEFAULT 2000) RETURNS TABLE(runtime_id uuid, runtime_name text, organization_id uuid, organization_name text, organization_slug text, owner_user_id uuid, owner_email text, owner_name text, link_agent text, link_agent_seen_at timestamp with time zone, link_last_seen_at timestamp with time zone, connected boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query
    select r.id, r.name, o.id, o.name, o.slug,
           ow.id, ow.email, ow.display_name,
           r.link_agent, r.link_agent_seen_at, r.link_last_seen_at,
           r.link_connected_at is not null
      from public.runtimes r
      join public.organizations o on o.id = r.organization_id
      left join lateral (
        select u.id, u.email, u.display_name
          from public.memberships m
          join public.users u on u.id = m.user_id
         where m.organization_id = o.id
           and m.role = 'owner'
           and m.revoked_at is null
         order by m.created_at
         limit 1
      ) ow on true
     where r.reachability = 'connector'
       and r.revoked_at is null
       and o.deleted_at is null
     order by o.name, r.name, r.id
     limit greatest(1, least(coalesce(p_limit, 2000), 2000));
end;
$$;

-- comment: FUNCTION staff_runtime_connectors(p_limit integer)
COMMENT ON FUNCTION public.staff_runtime_connectors(p_limit integer) IS 'Runtimes connector non révoqués des organisations vivantes, avec la version déclarée du connecteur (link_agent), le premier propriétaire actif et l''état du lien. Lecture staff seule, `p_limit` borné à 2000.';

-- function: staff_runtime_link_alerts(text, integer, timestamp with time zone)
CREATE FUNCTION public.staff_runtime_link_alerts(p_status text DEFAULT 'open'::text, p_limit integer DEFAULT 100, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id uuid, status text, kind text, organization_id uuid, organization_name text, organization_slug text, runtime_id uuid, runtime_name text, reason text, down_since timestamp with time zone, opened_at timestamp with time zone, resolved_at timestamp with time zone, concerned_user_id uuid, concerned_user_email text, concerned_user_name text, notified_at timestamp with time zone, notified_recipients integer, acknowledged_at timestamp with time zone, acknowledged_by_email text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
#variable_conflict use_column
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'resolved', 'all') then
    raise exception 'invalid alert status' using errcode = '22023';
  end if;

  return query
    select a.id, a.status, a.kind, a.organization_id, o.name, o.slug,
           a.runtime_id, a.runtime_name, a.reason, a.down_since, a.opened_at, a.resolved_at,
           a.concerned_user_id, u.email, u.display_name,
           a.notified_at, a.notified_recipients, a.acknowledged_at, su.email
      from public.runtime_link_alerts a
      left join public.organizations o on o.id = a.organization_id
      left join public.users u on u.id = a.concerned_user_id
      left join public.staff_users su on su.id = a.acknowledged_by
     where (p_status = 'all' or a.status = p_status)
       and (p_before is null or a.opened_at < p_before)
     order by a.opened_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- comment: FUNCTION staff_runtime_link_alerts(p_status text, p_limit integer, p_before timestamp with time zone)
COMMENT ON FUNCTION public.staff_runtime_link_alerts(p_status text, p_limit integer, p_before timestamp with time zone) IS 'Alertes de lien connecteur servies au backoffice staff, les plus récentes d''abord. `p_status` : open, resolved ou all. Pagination par curseur `p_before` sur `opened_at`, `p_limit` borné à 500.';

-- function: staff_search_users(text, text, integer, timestamp with time zone, text, uuid)
CREATE FUNCTION public.staff_search_users(p_query text DEFAULT NULL::text, p_assistance text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_cursor_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_email text DEFAULT NULL::text, p_cursor_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, email text, display_name text, created_at timestamp with time zone, last_login_at timestamp with time zone, onboarding_completed boolean, can_impersonate boolean, total_count bigint, remaining_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  bounded_limit int;
  needle text;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  bounded_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  needle := nullif(btrim(coalesce(p_query, '')), '');
  if needle is not null then
    needle := '%' || replace(replace(replace(lower(needle), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with candidates as (
    select u.id as candidate_id,
           u.email as candidate_email,
           u.display_name as candidate_display_name,
           u.created_at as candidate_created_at,
           u.last_login_at as candidate_last_login_at,
           u.onboarding_completed as candidate_onboarding_completed,
           exists (
             select 1
               from public.memberships m
               join public.organizations o on o.id = m.organization_id
              where m.user_id = u.id
                and o.deleted_at is null
           ) as candidate_can_impersonate
      from public.users u
     where needle is null
        or lower(u.email) like needle escape '\'
        or lower(coalesce(u.display_name, '')) like needle escape '\'
  ),
  filtered as (
    select c.*,
           (
             p_cursor_created_at is null
             or p_cursor_id is null
             or c.candidate_created_at < p_cursor_created_at
             or (c.candidate_created_at = p_cursor_created_at
                 and lower(c.candidate_email) > coalesce(p_cursor_email, ''))
             or (c.candidate_created_at = p_cursor_created_at
                 and lower(c.candidate_email) = coalesce(p_cursor_email, '')
                 and c.candidate_id > p_cursor_id)
           ) as after_cursor
      from candidates c
     where p_assistance is null
        or (p_assistance = 'available' and c.candidate_can_impersonate)
        or (p_assistance = 'unavailable' and not c.candidate_can_impersonate)
  ),
  counted as (
    select count(*) as filter_total,
           count(*) filter (where f.after_cursor) as filter_remaining
      from filtered f
  )
  select f.candidate_id,
         f.candidate_email,
         f.candidate_display_name,
         f.candidate_created_at,
         f.candidate_last_login_at,
         f.candidate_onboarding_completed,
         f.candidate_can_impersonate,
         counted.filter_total,
         counted.filter_remaining
    from filtered f
   cross join counted
   where f.after_cursor
   order by f.candidate_created_at desc, lower(f.candidate_email), f.candidate_id
   limit bounded_limit;
end;
$$;

-- comment: FUNCTION staff_search_users(p_query text, p_assistance text, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_email text, p_cursor_id uuid)
COMMENT ON FUNCTION public.staff_search_users(p_query text, p_assistance text, p_limit integer, p_cursor_created_at timestamp with time zone, p_cursor_email text, p_cursor_id uuid) IS 'Page de comptes pour le backoffice staff : recherche e-mail / nom échappée, filtre d''assistance, borne plafonnée à 200 et curseur keyset (created_at, lower(email), id). Rend le total du filtre, le reste à partir du curseur, la dernière connexion du compte (null quand aucune n''a été vue depuis 0075) et l''état de son accueil (users.onboarding_completed, 0025) ; ne remplace jamais une borne par un offset.';

-- function: staff_set_permission_pipeline(uuid, text)
CREATE FUNCTION public.staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text) RETURNS TABLE(status text, previous_pipeline text, current_pipeline text, reverted_gates integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
  current_value text;
  reverted integer := 0;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null or not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if p_pipeline is null or p_pipeline not in ('legacy', 'v2') then
    raise exception 'unknown permission pipeline' using errcode = '22023';
  end if;

  select o.permission_pipeline into current_value
    from public.organizations o
   where o.id = p_organization_id and o.deleted_at is null
   for update;
  if current_value is null then
    return;
  end if;
  if current_value = p_pipeline then
    return query select 'unchanged'::text, current_value, current_value, 0;
    return;
  end if;

  if p_pipeline = 'v2' then
    if not exists (
      select 1 from public.service_instances si
       where si.service = 'worker' and si.heartbeat_at > now() - interval '10 minutes'
    ) or exists (
      select 1 from public.service_instances si
       where si.service = 'worker' and si.heartbeat_at > now() - interval '10 minutes'
         and not ('v2' = any(coalesce(si.permission_pipelines, array[]::text[])))
    ) then
      return query select 'workers_not_ready'::text, current_value, current_value, 0;
      return;
    end if;
    if exists (
      select 1 from public.runs r
       where r.organization_id = p_organization_id
         and r.status in ('starting', 'running', 'awaiting_approval')
         and r.lease_expires_at > now()
    ) then
      return query select 'runs_in_flight'::text, current_value, current_value, 0;
      return;
    end if;
  else
    -- Back to `legacy`: a decision the pipeline took and Hermes has not
    -- received yet goes back to a human. Nothing is lost, nothing is sent.
    -- A gate a worker is claiming right now is skipped, not waited for: that
    -- worker waits on this organization row, and it leaves with the decision
    -- it already holds.
    with candidates as (
      select a.id from public.approval_requests a
       where a.organization_id = p_organization_id
         and a.decided_by_kind = 'policy' and a.forward_state in ('pending', 'ready')
       for update skip locked
    ), reverted_rows as (
      update public.approval_requests a
         set status = 'pending', selected_choice = null, resolved_at = null, resolved_by_policy = null,
             forward_state = 'pending', decision_state = 'awaiting_human', decision_stage = null,
             decided_by_kind = null, decision_detail = jsonb_build_object('revertedToLegacy', true)
        from candidates c
       where a.id = c.id
      returning 1
    )
    select count(*)::integer into reverted from reverted_rows;
  end if;

  update public.organizations set permission_pipeline = p_pipeline where id = p_organization_id;
  return query select 'switched'::text, current_value, p_pipeline, reverted;
end;
$$;

-- comment: FUNCTION staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text)
COMMENT ON FUNCTION public.staff_set_permission_pipeline(p_organization_id uuid, p_pipeline text) IS 'Switches an organization between the legacy permission heuristic and the v2 pipeline (PERM2-1). Refuses v2 (workers_not_ready, runs_in_flight) while an old worker or a leased run could answer a gate the old way; back to legacy, returns undelivered policy decisions to a human. Guarded by app.staff_user_id.';

-- function: staff_user_counts()
CREATE FUNCTION public.staff_user_counts() RETURNS TABLE(total_count bigint, signups_7d bigint, signups_30d bigint, impersonable_count bigint, last_created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  return query
  select count(*)::bigint,
         count(*) filter (where u.created_at >= now() - interval '7 days')::bigint,
         count(*) filter (where u.created_at >= now() - interval '30 days')::bigint,
         count(*) filter (
           where exists (
             select 1
               from public.memberships m
               join public.organizations o on o.id = m.organization_id
              where m.user_id = u.id
                and o.deleted_at is null
           )
         )::bigint,
         max(u.created_at)
    from public.users u;
end;
$$;

-- comment: FUNCTION staff_user_counts()
COMMENT ON FUNCTION public.staff_user_counts() IS 'Compteurs de comptes du tableau de bord staff : total, inscriptions à 7 et 30 jours, comptes avec un accès actif (même prédicat que can_impersonate) et date du dernier compte créé.';

-- function: stamp_email_delivery_failure()
CREATE FUNCTION public.stamp_email_delivery_failure() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if new.status = 'failed' or (new.status = 'pending' and new.last_error is not null) then
    if tg_op = 'INSERT' then
      new.last_delivery_failure_at := now();
    elsif new.status is distinct from old.status
       or new.attempts is distinct from old.attempts
       or new.last_error is distinct from old.last_error then
      new.last_delivery_failure_at := now();
    end if;
  end if;
  return new;
end;
$$;

-- function: support_notify_recipients()
CREATE FUNCTION public.support_notify_recipients() RETURNS TABLE(staff_user_id uuid, email text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select su.id, su.email
    from public.staff_users su
   where su.disabled_at is null
   order by su.created_at asc
$$;

-- function: support_staff_session()
CREATE FUNCTION public.support_staff_session() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select exists (
    select 1 from public.staff_users su
     where su.id = nullif(current_setting('app.staff_user_id', true), '')::uuid
       and su.disabled_at is null
  );
$$;

-- function: sync_approval_forward_state_legacy()
CREATE FUNCTION public.sync_approval_forward_state_legacy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

-- function: workflow_email_recipient(jsonb)
CREATE FUNCTION public.workflow_email_recipient(payload jsonb) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select u.email from public.user_workspace_preferences p
    join public.memberships m on m.organization_id=p.organization_id and m.user_id=p.user_id and m.revoked_at is null
    join public.users u on u.id=p.user_id
    join public.organizations o on o.id=p.organization_id and o.deleted_at is null
    join public.workflows w on w.organization_id=p.organization_id and w.initiator_user_id=p.user_id
    join public.threads t on t.organization_id=w.organization_id and t.id=w.thread_id
    left join public.bots b on b.organization_id=t.organization_id and b.id=t.bot_id
    where p.organization_id=(payload->>'organizationId')::uuid and p.user_id=(payload->>'userId')::uuid
      and w.id=(payload->>'workflowId')::uuid and w.notification_sequence=(payload->>'sequence')::bigint
      and (t.bot_id is null or b.deleted_at is null)
      and case payload->>'category'
        when 'approval' then w.status='awaiting_approval' and p.approval_enabled_at <= (payload->>'occurredAt')::timestamptz
        when 'completed' then w.status='completed' and p.completed_enabled_at <= (payload->>'occurredAt')::timestamptz
        when 'failed' then w.status in ('failed','expired','unknown') and p.failed_enabled_at <= (payload->>'occurredAt')::timestamptz
        else false end;
$$;

-- function: workspace_access(uuid, uuid)
CREATE FUNCTION public.workspace_access(p_user uuid, p_org uuid) RETURNS TABLE(role text, kind text, via_agency_ids uuid[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  with target as (
    select o.id, o.kind from public.organizations o
     where o.id = p_org and o.deleted_at is null
  )
  select (select m.role from public.memberships m
           where m.organization_id = t.id and m.user_id = p_user and m.revoked_at is null
           limit 1),
         t.kind,
         '{}'::uuid[]
    from target t;
$$;

-- function: workspace_business_metrics(uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone)
CREATE FUNCTION public.workspace_business_metrics(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone, p_now timestamp with time zone) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  with activity as (select * from public.workspace_run_activity(p_org, p_from, p_until)),
  totals as (
    select count(*) as runs, count(*) filter (where status = 'completed') as completed,
      count(*) filter (where status = 'failed') as failed, coalesce(sum(total_tokens), 0) as tokens,
      count(*) filter (where total_tokens is not null) as measured,
      count(*) filter (where status in ('completed', 'failed') and total_tokens is null) as unknown
    from activity
  )
  select jsonb_build_object(
    'activeBots', (select count(*) from public.bots where organization_id = p_org and deleted_at is null and archived_at is null),
    'archivedBots', (select count(*) from public.bots where organization_id = p_org and deleted_at is null and archived_at is not null),
    'runsTotal', t.runs,
    'runsRunning', (select count(*) from public.runs where organization_id = p_org and status in ('starting','running','awaiting_approval')),
    'runsQueued', (select count(*) from public.runs where organization_id = p_org and status = 'queued'),
    'pendingApprovals', (select count(*) from public.approval_requests where organization_id = p_org
      and status = 'pending' and forward_state = 'pending' and selected_choice is null and expires_at > p_now),
    'completed', t.completed, 'failed', t.failed, 'tokens', t.tokens,
    'tokensMeasuredRuns', t.measured, 'tokensUnknownRuns', t.unknown,
    'successRate', case when t.completed + t.failed > 0 then round(100.0 * t.completed / (t.completed + t.failed), 2) end,
    'providerIncidents', (select count(*) from public.runtime_provider_incidents i
      join public.runtimes r on r.id = i.runtime_id and r.organization_id = i.organization_id
      where i.organization_id = p_org and i.until > p_now and r.is_active and r.revoked_at is null),
    'runtimeIncidents', (select count(*) from public.runtimes where organization_id = p_org and is_active and revoked_at is null
      and last_health_status is not null and last_health_status not in ('healthy','unknown'))
  ) from totals t;
$$;

-- function: workspace_run_activity(uuid, timestamp with time zone, timestamp with time zone)
CREATE FUNCTION public.workspace_run_activity(p_org uuid, p_from timestamp with time zone, p_until timestamp with time zone) RETURNS TABLE(id uuid, status text, observed_at timestamp with time zone, input_tokens numeric, output_tokens numeric, total_tokens numeric)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  select r.id, r.status, coalesce(r.ended_at, r.created_at),
    case when r.usage->>'inputTokens' ~ '^[0-9]+$' then (r.usage->>'inputTokens')::numeric end,
    case when r.usage->>'outputTokens' ~ '^[0-9]+$' then (r.usage->>'outputTokens')::numeric end,
    case when r.usage->>'totalTokens' ~ '^[0-9]+$' then (r.usage->>'totalTokens')::numeric end
  from public.runs r where r.organization_id = p_org
    and (p_from is null or coalesce(r.ended_at, r.created_at) >= p_from)
    and (p_until is null or coalesce(r.ended_at, r.created_at) < p_until);
$_$;

SET default_tablespace = '';

SET default_table_access_method = heap;

INSERT INTO schema_migrations(version) VALUES ('0002_functions') ON CONFLICT DO NOTHING;

COMMIT;
