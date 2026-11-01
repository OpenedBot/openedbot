-- OHB-15. La cible SSH d un runtime quitte le schema.
--
-- Une migration jouee sur une base neuve ne prouve rien : le cas reel est une
-- base qui PORTE deja les colonnes, avec les contraintes posees en 0002
-- (runtimes_ssh_port_check, et le couple hote/utilisateur). La preuve remet
-- donc les colonnes en place, rejoue le contenu de 0022, puis exige :
--
--   1. les trois colonnes absentes ;
--   2. aucune contrainte residuelle qui les nommait ;
--   3. le rejeu de la migration sans erreur, donc idempotent.
--
-- Ce depot n a pas de migration descendante : retirer une colonne est
-- irreversible sans restauration. C est assume et documente, pas oublie.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

alter table runtimes add column if not exists ssh_host text;
alter table runtimes add column if not exists ssh_port integer not null default 22;
alter table runtimes add column if not exists ssh_user text;

do $$
begin
  begin
    alter table runtimes add constraint runtimes_ssh_port_check
      check (ssh_port between 1 and 65535);
  exception when duplicate_object then null;
  end;
  begin
    alter table runtimes add constraint runtimes_ssh_pair_check
      check ((ssh_host is null and ssh_user is null)
             or (ssh_host is not null and ssh_user is not null));
  exception when duplicate_object then null;
  end;
end $$;

create temp table ssh_drop_proof (before_columns int, after_columns int,
                                  residual_constraints int, replayed text);

insert into ssh_drop_proof
select count(*), -1, -1, 'not-replayed'
  from information_schema.columns
 where table_name = 'runtimes'
   and column_name in ('ssh_host', 'ssh_port', 'ssh_user');

-- Le contenu exact de 0022, joue sur une base qui porte les colonnes.
alter table runtimes drop column if exists ssh_host;
alter table runtimes drop column if exists ssh_port;
alter table runtimes drop column if exists ssh_user;

-- Rejeu : la migration doit rester sans effet et sans erreur.
do $$
begin
  alter table runtimes drop column if exists ssh_host;
  alter table runtimes drop column if exists ssh_port;
  alter table runtimes drop column if exists ssh_user;
  update ssh_drop_proof set replayed = 'idempotent';
exception when others then
  update ssh_drop_proof set replayed = 'failed';
end $$;

update ssh_drop_proof set after_columns = (
  select count(*) from information_schema.columns
   where table_name = 'runtimes'
     and column_name in ('ssh_host', 'ssh_port', 'ssh_user')
);

-- Postgres retire d office une contrainte qui ne depend que des colonnes
-- supprimees. On l exige plutot que de le supposer.
update ssh_drop_proof set residual_constraints = (
  select count(*) from pg_constraint
   where conrelid = 'runtimes'::regclass
     and conname in ('runtimes_ssh_port_check', 'runtimes_ssh_pair_check')
);

select before_columns || '/' || after_columns || '/' || residual_constraints
       || '/' || replayed
  from ssh_drop_proof;
