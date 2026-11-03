-- Repair job errors stored as a JSON string scalar instead of an object.
--
-- Until 2026-10-24 three writers bound `${JSON.stringify(error)}::jsonb`: Bun
-- sends that string as a jsonb value, so PostgreSQL stored the string itself
-- ("{\"code\":...}"), and the console found no `code` to show. New writes bind
-- the object. This turns the rows already written back into objects:
-- runtime_model_selection_proofs, bot_profile_provisions, bot_host_cleanups.
-- The event and audit tables check `jsonb_typeof(...) = 'object'`: they
-- refused those writes and hold nothing to repair.
--
-- Each string is parsed on its own: one that is not a JSON object (truncated,
-- plain text) is left as it is rather than failing the whole migration.
--
-- The three tables FORCE row level security; the schema owner ohb_migrator
-- carries BYPASSRLS (docs/cloud/PRODUCTION.md), so this update sees every
-- tenant's rows.
begin;

do $$
declare
  target text;
  item record;
  parsed jsonb;
begin
  foreach target in array array['runtime_model_selection_proofs', 'bot_profile_provisions', 'bot_host_cleanups'] loop
    for item in execute format(
      'select ctid as row_id, error #>> ''{}'' as body from %I where jsonb_typeof(error) = ''string''',
      target
    ) loop
      begin
        parsed := item.body::jsonb;
      exception when others then
        parsed := null;
      end;
      if jsonb_typeof(parsed) = 'object' then
        execute format('update %I set error = $1 where ctid = $2', target) using parsed, item.row_id;
      end if;
    end loop;
  end loop;
end
$$;

insert into schema_migrations(version) values ('0132_jsonb_string_error_repair')
on conflict (version) do nothing;

commit;
