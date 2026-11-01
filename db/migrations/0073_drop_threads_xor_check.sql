begin;

-- 0045 a tenté de supprimer l'ancien xor anonyme de `threads` (0004,
-- `threads_check`) en filtrant sur `pg_get_constraintdef(oid) like
-- '%is not null%'`. `pg_get_constraintdef` rend « IS NOT NULL » en
-- MAJUSCULES et `like` est sensible à la casse : le filtre n'a jamais
-- matché, la contrainte est restée, et elle interdit encore le fil de
-- service du brouillon de persona (bot_id et group_id tous deux nuls),
-- en plus de la nouvelle `threads_owner_at_most_one` (`<= 1`) qui, elle,
-- l'autorise. Idempotent : rejouable sans effet si déjà appliquée.

alter table public.threads drop constraint if exists threads_check;

-- Filet : toute autre contrainte check résiduelle qui exprimerait le même
-- xor strict (bot_id, group_id, = 1), quelle que soit sa casse ou son nom,
-- sans toucher `threads_owner_at_most_one` ni les autres checks de la table.
do $$
declare
  cname text;
begin
  for cname in
    select conname
      from pg_constraint
     where conrelid = 'public.threads'::regclass
       and contype = 'c'
       and conname <> 'threads_owner_at_most_one'
       and pg_get_constraintdef(oid) ilike '%bot_id%'
       and pg_get_constraintdef(oid) ilike '%group_id%'
       and pg_get_constraintdef(oid) ilike '%= 1%'
  loop
    execute format('alter table public.threads drop constraint %I', cname);
  end loop;
end $$;

insert into schema_migrations(version) values ('0073_drop_threads_xor_check')
on conflict (version) do nothing;

commit;
