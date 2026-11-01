begin;

-- OHB-23 : un fait issu de `remember:` ou d'une extraction reste en attente
-- jusqu'à une décision opérateur. Les lignes existantes (opérateur ou bot
-- déjà injectées) sont `accepted`. RLS inchangée : même table, mêmes policies.

alter table bot_memories
  add column status text not null default 'accepted'
    constraint bot_memories_status_check check (status in ('pending', 'accepted', 'rejected'));

comment on column bot_memories.status is
  'pending = propose par le bot, pas encore tranche ; accepted = injecte au prompt ; rejected = refuse, inactif.';

create index bot_memories_pending_idx
  on bot_memories (organization_id, bot_id, created_at desc, id desc)
  where status = 'pending';

insert into schema_migrations(version) values ('0042_bot_memory_approval')
on conflict (version) do nothing;

commit;
