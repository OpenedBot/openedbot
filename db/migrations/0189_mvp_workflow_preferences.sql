begin;

create table user_workspace_preferences (
  organization_id uuid not null,
  user_id uuid not null,
  approval_enabled_at timestamptz,
  completed_enabled_at timestamptz,
  failed_enabled_at timestamptz,
  locale text not null default 'fr' check (locale in ('fr','en')),
  checklist_hidden boolean not null default false,
  primary key (organization_id,user_id),
  foreign key (organization_id,user_id) references memberships(organization_id,user_id) on delete cascade
);
alter table user_workspace_preferences enable row level security;
alter table user_workspace_preferences force row level security;
create policy user_workspace_preferences_personal on user_workspace_preferences to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id',true),'')::uuid);
grant select,insert,update on user_workspace_preferences to openedbot_api;

create table workspace_activation (
  organization_id uuid primary key references organizations(id) on delete cascade,
  machine boolean not null default false,
  model boolean not null default false,
  bot boolean not null default false,
  result boolean not null default false
);
alter table workspace_activation enable row level security;
alter table workspace_activation force row level security;
create policy workspace_activation_tenant on workspace_activation to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
grant select,insert,update on workspace_activation to openedbot_api;

alter table email_outbox drop constraint email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation','agency_client_response','organization_member_invitation',
  'staff_account_created','staff_password_reset','staff_login_code','email_login_code',
  'provider_quota_reached','account_purge_completed','account_closure_notice',
  'support_new_conversation','runtime_link_down','runtime_link_restored','runtime_connector_outdated',
  'workflow_approval','workflow_completed','workflow_failed'
));

-- Trigger-owned facts survive deletion of the successful run or linked machine.
create function public.record_workspace_activation() returns trigger
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
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
revoke all on function public.record_workspace_activation() from public;
create trigger mvp_activation_runtime after insert or update on runtimes
  for each row execute function public.record_workspace_activation();
create trigger mvp_activation_model after insert on runtime_model_proven
  for each row execute function public.record_workspace_activation();
create trigger mvp_activation_bot after insert or update on bot_profile_provisions
  for each row execute function public.record_workspace_activation();
create trigger mvp_activation_result after insert or update of status on workflows
  for each row execute function public.record_workspace_activation();

create function public.enqueue_workflow_email() returns trigger
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
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
revoke all on function public.enqueue_workflow_email() from public;
create trigger workflows_email after update of status on workflows
  for each row execute function public.enqueue_workflow_email();

-- Only the worker can revalidate a queued alert; no broad API read of the outbox.
create function public.workflow_email_recipient(payload jsonb) returns text
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
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
revoke all on function public.workflow_email_recipient(jsonb) from public;
grant execute on function public.workflow_email_recipient(jsonb) to openedbot_worker;
insert into schema_migrations(version) values('0189_mvp_workflow_preferences') on conflict do nothing;
commit;
