begin;

-- OHB-24 : une routine vise un bot (DM) XOR un salon. Meme xor que threads
-- (`bot_id is not null <> group_id is not null`). Le tick ouvre un envoi de
-- salon par le meme chemin qu'un message operateur (`initGroupSend`).

alter table routines
  alter column bot_id drop not null,
  add column group_id uuid;

alter table routines
  add constraint routines_bot_xor_group
    check ((bot_id is not null) <> (group_id is not null)),
  add constraint routines_group_fk
    foreign key (organization_id, group_id)
    references bot_groups(organization_id, id) on delete cascade;

create index routines_group_idx
  on routines (organization_id, group_id, created_at)
  where group_id is not null;

comment on column routines.group_id is
  'Salon cible, exclusif de bot_id. Un tir ouvre un envoi de salon (workflow kind group).';

insert into schema_migrations(version) values ('0044_routine_group')
on conflict (version) do nothing;

commit;
