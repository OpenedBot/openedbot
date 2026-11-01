begin;

-- L'appairage par QR est retiré du produit avec l'écran « Réglages ›
-- Application » qui l'hébergeait : plus rien ne crée, ne surveille ni
-- n'échange un appairage (`device-pairing-routes.ts`, l'écran `/pair` et le
-- scanner embarqué sont supprimés). Une table qui ne peut plus qu'expirer est
-- une surface d'attaque sans fonction : elle portait des secrets hachés
-- capables d'ouvrir une session tant qu'ils vivaient.
--
-- PERTE DE DONNÉES ASSUMÉE : les appairages en attente disparaissent. Aucun
-- d'eux ne vaut plus de trois minutes, et aucun n'était rejouable.
--
-- Les SESSIONS déjà créées par un appairage ne sont PAS touchées : ce sont des
-- sessions web ordinaires, créées par `createWebSession`, révocables depuis
-- « Sécurité du compte » comme n'importe quelle autre. `session_id` n'était
-- qu'une trace, jamais une dépendance de `sessions`.

drop table if exists device_pairings;

insert into schema_migrations(version) values ('0028_drop_device_pairings')
on conflict (version) do nothing;

commit;
