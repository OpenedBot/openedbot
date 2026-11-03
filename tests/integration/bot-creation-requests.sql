-- 0135 proof: a creation request id names at most one bot per organization,
-- two tenants may reuse the same id, existing bots keep a null id, and the
-- API role reads the replay row of its own tenant only.
-- 0136 proof: the request digest is a SHA-256 hex, stored only next to an id.
insert into organizations (id, slug, name) values
  ('9c000000-0000-4000-8000-000000000001', 'creation-a', 'Creation A'),
  ('9d000000-0000-4000-8000-000000000002', 'creation-b', 'Creation B');
insert into sections (id, organization_id, name, position) values
  ('9c000000-0000-4000-8000-000000000011', '9c000000-0000-4000-8000-000000000001', 'A', 0),
  ('9d000000-0000-4000-8000-000000000012', '9d000000-0000-4000-8000-000000000002', 'B', 0);
-- Bots created before 0135: no request id, several per tenant.
insert into bots (id, organization_id, section_id, name, slug, position) values
  ('9c000000-0000-4000-8000-000000000021', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011', 'Legacy one', 'legacy-one', 0),
  ('9c000000-0000-4000-8000-000000000022', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011', 'Legacy two', 'legacy-two', 1);
set role ohb_api;
select set_config('app.organization_id', '9c000000-0000-4000-8000-000000000001', false) \g /dev/null
do $$
begin
  if (select count(*) from bots where creation_request_id is null) <> 2 then raise exception 'legacy bots lost their null request id'; end if;
  insert into bots (id, organization_id, section_id, name, slug, position, creation_request_id, label, permission_mode, notify_on_finish)
  values ('9c000000-0000-4000-8000-000000000031', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011',
          'Atlas', 'atlas', 2, '5e000000-0000-4000-8000-000000000001', 'Recherche', 'auto', false);
  if (select permission_mode from bots where creation_request_id = '5e000000-0000-4000-8000-000000000001') <> 'auto' then
    raise exception 'creation settings were not written with the row';
  end if;
  begin
    insert into bots (id, organization_id, section_id, name, slug, position, creation_request_id)
    values ('9c000000-0000-4000-8000-000000000032', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011',
            'Atlas two', 'atlas-two', 3, '5e000000-0000-4000-8000-000000000001');
    raise exception 'a request id created a second bot in the same tenant';
  exception when unique_violation then null;
  end;
  insert into bots (id, organization_id, section_id, name, slug, position, creation_request_id, creation_request_digest)
  values ('9c000000-0000-4000-8000-000000000034', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011',
          'Hermine', 'hermine', 4, '5e000000-0000-4000-8000-000000000002', repeat('ab', 32));
  if (select creation_request_digest from bots where creation_request_id = '5e000000-0000-4000-8000-000000000002') <> repeat('ab', 32) then
    raise exception 'the request digest was not stored with its id';
  end if;
  begin
    insert into bots (id, organization_id, section_id, name, slug, position, creation_request_id, creation_request_digest)
    values ('9c000000-0000-4000-8000-000000000035', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011',
            'Bad digest', 'bad-digest', 5, '5e000000-0000-4000-8000-000000000003', 'not-a-digest');
    raise exception 'a malformed request digest was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into bots (id, organization_id, section_id, name, slug, position, creation_request_digest)
    values ('9c000000-0000-4000-8000-000000000036', '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000011',
            'Orphan digest', 'orphan-digest', 6, repeat('cd', 32));
    raise exception 'a request digest without its id was accepted';
  exception when check_violation then null;
  end;
end
$$;
select set_config('app.organization_id', '9d000000-0000-4000-8000-000000000002', false) \g /dev/null
do $$
begin
  if (select count(*) from bots where creation_request_id = '5e000000-0000-4000-8000-000000000001') <> 0 then
    raise exception 'tenant B read the replay row of tenant A';
  end if;
  insert into bots (id, organization_id, section_id, name, slug, position, creation_request_id)
  values ('9d000000-0000-4000-8000-000000000033', '9d000000-0000-4000-8000-000000000002', '9d000000-0000-4000-8000-000000000012',
          'Atlas', 'atlas', 0, '5e000000-0000-4000-8000-000000000001');
end
$$;
reset role;
do $$
begin
  if (select count(*) from bots where creation_request_id = '5e000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'the same request id should exist once per tenant';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'bots'::regclass) then raise exception 'bots RLS is not forced'; end if;
end
$$;
select 'scoped/forced';
delete from organizations where id in (
  '9c000000-0000-4000-8000-000000000001',
  '9d000000-0000-4000-8000-000000000002'
);
