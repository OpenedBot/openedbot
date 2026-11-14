begin;

-- 0147 ouvrait `mobile_connect_tickets` au worker en using (true) : il aurait lu
-- les tickets de toutes les organisations, alors qu'un ticket vaut un mot de
-- passe pendant dix minutes. Aucune requête du worker ne nomme cette table
-- (seules les routes `apps/api/src/routes/identity/mobile-connect-routes.ts`
-- la lisent) et la purge d'une organisation passe par `on delete cascade`, qui
-- ne dépend pas de ses grants. Elle rejoint donc les tables retirées au worker
-- par 0080 et 0082 (`tests/integration/worker-policy-exceptions.sql`).

drop policy if exists mobile_connect_tickets_worker on mobile_connect_tickets;
revoke all on mobile_connect_tickets from openedbot_worker;

insert into schema_migrations(version) values ('0148_mobile_connect_tickets_worker_revoke')
on conflict (version) do nothing;

commit;
