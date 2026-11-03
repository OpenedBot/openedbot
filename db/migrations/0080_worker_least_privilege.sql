-- Le worker perd ce qu'il n'a jamais lu.
--
-- Chaque table tenant ouvre au rôle `ohb_worker` une policy `using (true)` :
-- le worker traverse les organisations (file de runs, maintenance) et ne pose
-- jamais `app.organization_id`. Pour les tables qu'il consulte, c'est la dette
-- que la suite rembourse table par table. Pour les cinq ci-dessous, ce n'est
-- même pas une dette : aucune requête de `apps/worker/src` ni de
-- `packages/profile-imports/src` ne les nomme, aucune fonction appelée par le
-- worker ne les lit, et aucun trigger déclenché par ses écritures n'y touche.
-- Un worker compromis y lisait pourtant les sessions et les invitations de
-- toutes les organisations.
--
-- Les suppressions en cascade depuis `organizations` (purge d'un tenant par
-- `maintenance/deletion.ts`) ne dépendent ni de ces grants ni de ces policies :
-- les actions d'intégrité référentielle contournent la RLS.
--
-- `tests/integration/worker-policy-exceptions.sql` fige la liste des policies
-- `using (true)` qui restent au worker : une nouvelle doit être une décision.
begin;

drop policy if exists sessions_worker on sessions;
drop policy if exists native_auth_codes_worker on native_auth_codes;
drop policy if exists organization_invitations_worker on organization_invitations;
drop policy if exists decisions_worker on decisions;
drop policy if exists runtime_link_dispatches_worker on runtime_link_dispatches;

revoke all on sessions, native_auth_codes, organization_invitations, decisions,
  runtime_link_dispatches from ohb_worker;

insert into schema_migrations(version) values ('0080_worker_least_privilege') on conflict (version) do nothing;

commit;
