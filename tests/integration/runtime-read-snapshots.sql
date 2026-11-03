-- Proves tenant isolation and the API-only privilege boundary.
insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active) values
  ('60000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000001', 'Snapshot A', 'connector', 'snapshot-link-a', false),
  ('60000000-0000-4000-8000-000000000092', '20000000-0000-4000-8000-000000000002', 'Snapshot B', 'connector', 'snapshot-link-b', false);
insert into runtime_read_snapshots (organization_id, runtime_id, kind, document, observed_at) values
  ('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000091', 'mcp', '{"value":"a"}', now()),
  ('20000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000092', 'mcp', '{"value":"b"}', now());

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
do $$
begin
  if (select count(*) from runtime_read_snapshots) <> 1 then
    raise exception 'tenant A did not see exactly its own snapshot';
  end if;
  if (select count(*) from runtime_read_snapshots where organization_id = '20000000-0000-4000-8000-000000000002') <> 0 then
    raise exception 'tenant A read tenant B snapshot';
  end if;
  update runtime_read_snapshots set document = '{"value":"changed"}'
   where organization_id = '20000000-0000-4000-8000-000000000002';
  if found then raise exception 'tenant A updated tenant B snapshot'; end if;
  begin
    insert into runtime_read_snapshots (organization_id, runtime_id, kind, document, observed_at)
    values ('20000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000092', 'models', '{}', now());
    raise exception 'tenant A inserted tenant B snapshot';
  exception when insufficient_privilege then
    null;
  end;
end
$$;
reset role;

do $$
begin
  if has_table_privilege('ohb_worker', 'runtime_read_snapshots', 'select,insert,update,delete') then
    raise exception 'ohb_worker has access to runtime_read_snapshots';
  end if;
end
$$;

delete from runtime_read_snapshots where runtime_id in (
  '60000000-0000-4000-8000-000000000091', '60000000-0000-4000-8000-000000000092'
);
delete from runtimes where id in (
  '60000000-0000-4000-8000-000000000091', '60000000-0000-4000-8000-000000000092'
);
select 'isolated/api-only';
