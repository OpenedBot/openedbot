-- `POST /api/waitlist` insère dans `waitlist_signups`, et n'en avait pas le
-- droit : 0063 a créé la table sans un seul `grant`, alors que chaque table du
-- schéma en donne un explicitement. Toute inscription sortait en 500
-- (« permission denied for table waitlist_signups »), sur une base à jour
-- comme sur une base neuve.
--
-- `openedbot_api` obtient l'insertion, et rien d'autre : ni `select`, ni `update`,
-- ni `delete`, exactement comme 0064 le lui accorde sur `email_outbox`. Cette
-- table porte des adresses en clair et aucune route ne la lit.
--
-- Ce droit d'écriture seule dicte la forme des deux insertions de la route
-- (`waitlist-routes.ts`, `transactional-email.ts`) : `on conflict do nothing`
-- sans nommer la colonne d'arbitrage, qui exigerait le `select` dessus, et
-- aucun `returning`, qui exigerait sous RLS une politique `select`. Le nombre
-- de lignes écrites suffit à distinguer une inscription neuve d'un doublon.
--
-- Pas de RLS ici, comme en 0063 : la table est hors tenant, il n'y a pas
-- encore d'organisation au moment de l'inscription.
begin;

grant insert on waitlist_signups to openedbot_api;

insert into schema_migrations(version) values ('0065_waitlist_signups_api') on conflict (version) do nothing;

commit;
