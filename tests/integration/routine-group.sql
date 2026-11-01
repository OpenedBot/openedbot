-- OHB-24 : routines.group_id xor bot_id, index, RLS. Pas d apostrophe isolee.

create temp table routine_group_proof (xor_both text, xor_none text, own int, other int);
insert into routine_group_proof values ('-', '-', -1, -1);
grant select, insert, update on routine_group_proof to ohb_api;

insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('10000000-0000-4000-8000-000000000023', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'Bot A2', 'bot-a2', 'profile-a2', 1);

insert into bot_groups (id, organization_id, section_id, name, position) values
  ('93000000-0000-4000-8000-000000000301', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'Salon A', 0),
  ('93000000-0000-4000-8000-000000000302', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000012', 'Salon B', 0);

insert into group_members (organization_id, group_id, bot_id, position) values
  ('10000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000301', '10000000-0000-4000-8000-000000000021', 0),
  ('10000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000301', '10000000-0000-4000-8000-000000000023', 1);

insert into threads (id, organization_id, group_id, title, hermes_session_id) values
  ('93000000-0000-4000-8000-000000000311', '10000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000301', 'Salon A', 'ohb-group-a'),
  ('93000000-0000-4000-8000-000000000312', '20000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000302', 'Salon B', 'ohb-group-b');

do $$
begin
  begin
    insert into routines (id, organization_id, bot_id, group_id, name, schedule, timezone, message, enabled)
    values (
      '93000000-0000-4000-8000-000000000321',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000021',
      '93000000-0000-4000-8000-000000000301',
      'Both', '0 9 * * *', 'UTC', 'x', true
    );
    update routine_group_proof set xor_both = 'accepted';
  exception when check_violation then
    update routine_group_proof set xor_both = 'refused';
  end;
  begin
    insert into routines (id, organization_id, bot_id, group_id, name, schedule, timezone, message, enabled)
    values (
      '93000000-0000-4000-8000-000000000322',
      '10000000-0000-4000-8000-000000000001',
      null, null, 'Neither', '0 9 * * *', 'UTC', 'x', true
    );
    update routine_group_proof set xor_none = 'accepted';
  exception when check_violation then
    update routine_group_proof set xor_none = 'refused';
  end;
end $$;

insert into routines (
  id, organization_id, bot_id, group_id, name, schedule, timezone, message, enabled
) values (
  '93000000-0000-4000-8000-000000000323',
  '10000000-0000-4000-8000-000000000001',
  null,
  '93000000-0000-4000-8000-000000000301',
  'Stand-up A', '0 9 * * 1-5', 'UTC', 'Tour.', true
), (
  '93000000-0000-4000-8000-000000000324',
  '20000000-0000-4000-8000-000000000002',
  null,
  '93000000-0000-4000-8000-000000000302',
  'Stand-up B', '0 9 * * 1-5', 'UTC', 'Tour.', true
);

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update routine_group_proof set own = (
  select count(*) from routines where group_id is not null
);
reset role;

set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update routine_group_proof set other = (
  select count(*) from routines
   where group_id = '93000000-0000-4000-8000-000000000302'
);
reset role;

select xor_both || '/' || xor_none || '/' || own || '/' || other from routine_group_proof;
