-- The run key of openedbot's own MCP tools never stays in a stored gate.
--
-- A host plugin older than edge-setup 1.5.7 puts every argument of an MCP
-- call in the gate descriptor (`openedbot-gate/v1`), the `run_key` of
-- `routine_manage` and `bot_settings_propose` included: the worker stored it
-- in `approval_requests.gate_args`, and the reviewer read it from there. The
-- worker now keeps only each tool's own fields (`platformToolArguments`,
-- modules/execution/src/domain/routine-gate.ts); this removes the run key,
-- and anything else outside those schemas, from the rows written before.
-- The keys were only valid during their run; the rows stay otherwise as they
-- are (digest, deletes, opaque, server, tool).
begin;

update approval_requests a
   set gate_args = jsonb_set(a.gate_args, '{args,arguments}', coalesce((
         select jsonb_object_agg(field.key, field.value)
           from jsonb_each(a.gate_args #> '{args,arguments}') as field(key, value)
          where (a.tool_key = 'mcp:openedbot_routines:routine_manage'
                  and field.key in ('action', 'job_id', 'name', 'prompt', 'schedule', 'timezone')
                  and jsonb_typeof(field.value) = 'string')
             or (a.tool_key = 'mcp:openedbot_routines:routine_manage'
                  and field.key = 'prompt_chars' and jsonb_typeof(field.value) = 'number')
             or (a.tool_key = 'mcp:openedbot_bot_settings:bot_settings_propose'
                  and field.key in ('reason', 'instructions', 'label', 'reply_language', 'notify_on_finish'))
       ), '{}'::jsonb))
 where a.tool_key in ('mcp:openedbot_routines:routine_manage', 'mcp:openedbot_bot_settings:bot_settings_propose')
   and a.gate_kind = 'plugin_tool'
   and jsonb_typeof(a.gate_args #> '{args,arguments}') = 'object';

insert into schema_migrations(version) values ('0188_approval_gate_run_key_scrub')
on conflict (version) do nothing;

commit;
