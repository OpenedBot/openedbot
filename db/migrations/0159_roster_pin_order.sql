-- Les épinglés de la barre latérale se rangent à la main, comme dans l'app de référence : déposer une tuile entre deux autres la place là, et l'ordre survit au
-- rechargement. Bots et salons partagent la même grille : `pin_position` est
-- un rang commun aux deux tables, écrit d'un bloc par
-- `PUT /api/sections/pinned/order`.
--
-- `null` = pas encore rangé (épinglé par le menu, ou avant cette migration) :
-- la console le place après les rangés, par activité. Désépingler efface le
-- rang. Pas de contrainte d'unicité : l'ordre est réécrit en entier à chaque
-- dépôt, et deux rangs égaux se départagent par activité.
begin;

alter table bots add column if not exists pin_position integer;
alter table bot_groups add column if not exists pin_position integer;

insert into schema_migrations(version) values ('0159_roster_pin_order')
on conflict (version) do nothing;

commit;
