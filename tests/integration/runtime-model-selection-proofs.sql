insert into organizations (id, slug, name) values
  ('7e000000-0000-4000-8000-000000000001', 'model-proof-a', 'Model Proof A'),
  ('7f000000-0000-4000-8000-000000000002', 'model-proof-b', 'Model Proof B');
insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active) values
  ('7e000000-0000-4000-8000-000000000011', '7e000000-0000-4000-8000-000000000001', 'A', 'connector', 'model-proof-a', false),
  ('7f000000-0000-4000-8000-000000000012', '7f000000-0000-4000-8000-000000000002', 'B', 'connector', 'model-proof-b', false);
insert into runtime_model_selection_proofs (runtime_id, organization_id, provider, model) values
  ('7e000000-0000-4000-8000-000000000011', '7e000000-0000-4000-8000-000000000001', 'anthropic', 'claude-sonnet-4'),
  ('7f000000-0000-4000-8000-000000000012', '7f000000-0000-4000-8000-000000000002', 'openai-codex', 'gpt-6');
insert into runtime_model_proven (organization_id, runtime_id, provider, model) values
  ('7e000000-0000-4000-8000-000000000001', '7e000000-0000-4000-8000-000000000011', 'anthropic', 'claude-sonnet-4'),
  ('7f000000-0000-4000-8000-000000000002', '7f000000-0000-4000-8000-000000000012', 'openai-codex', 'gpt-6');
set role openedbot_api;
select set_config('app.organization_id', '7e000000-0000-4000-8000-000000000001', false) \g /dev/null
do $$
begin
  if (select count(*) from runtime_model_selection_proofs) <> 1 then raise exception 'tenant A did not see its proof'; end if;
  if (select count(*) from runtime_model_selection_proofs where organization_id = '7f000000-0000-4000-8000-000000000002') <> 0 then raise exception 'tenant A saw tenant B proof'; end if;
  update runtime_model_selection_proofs set status = 'failed' where runtime_id = '7e000000-0000-4000-8000-000000000011';
  if not found then raise exception 'tenant A could not update its proof'; end if;
  delete from runtime_model_selection_proofs where runtime_id = '7f000000-0000-4000-8000-000000000012';
  if found then raise exception 'tenant A deleted tenant B proof'; end if;
  if (select count(*) from runtime_model_proven) <> 1 then raise exception 'tenant A did not see its proven model'; end if;
  if (select count(*) from runtime_model_proven where organization_id = '7f000000-0000-4000-8000-000000000002') <> 0 then raise exception 'tenant A saw tenant B proven model'; end if;
  update runtime_model_proven set proven_at = now() where runtime_id = '7e000000-0000-4000-8000-000000000011';
  if not found then raise exception 'tenant A could not update its proven model'; end if;
  delete from runtime_model_proven where runtime_id = '7f000000-0000-4000-8000-000000000012';
  if found then raise exception 'tenant A deleted tenant B proven model'; end if;
end
$$;
reset role;
do $$
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'runtime_model_selection_proofs'::regclass) then raise exception 'model proof RLS is not forced'; end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'runtime_model_proven'::regclass) then raise exception 'proven model RLS is not forced'; end if;
end
$$;
select 'isolated/forced';
delete from organizations where id in ('7e000000-0000-4000-8000-000000000001', '7f000000-0000-4000-8000-000000000002');
