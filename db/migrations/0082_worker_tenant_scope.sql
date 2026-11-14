-- Le worker lit quatre tables sous le tenant du run, et en perd deux.
--
-- Suite de 0080. Ces accès du worker sont autonomes : chacun ouvre sa propre
-- transaction avec l'organisation du run (`apps/worker/src/infrastructure/tenant.ts`),
-- aucun ne vit dans une transaction ouverte plus haut sans tenant, aucune
-- fonction SQL ni aucun trigger ne les lit.
--
--   runtime_provider_incidents : provider-fallback.ts
--   thread_compactions         : compact-thread.ts
--   playbooks, bot_playbooks   : runner.ts (loadAssignedPlaybooks)
--
-- La policy devient celle d'`openedbot_api` : sans `app.organization_id`, aucune
-- ligne. `tests/integration/worker-tenant-scope.ts` appelle ces fonctions sous
-- `openedbot_worker` avec deux organisations.
--
-- `message_reactions` et `support_messages` ne sont nommées par aucune requête
-- du worker ; les suppressions en cascade d'une purge ne dépendent pas de ces
-- grants.
begin;

drop policy if exists runtime_provider_incidents_worker on runtime_provider_incidents;
create policy runtime_provider_incidents_worker on runtime_provider_incidents to openedbot_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

drop policy if exists thread_compactions_worker on thread_compactions;
create policy thread_compactions_worker on thread_compactions to openedbot_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

drop policy if exists playbooks_worker on playbooks;
create policy playbooks_worker on playbooks to openedbot_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

drop policy if exists bot_playbooks_worker on bot_playbooks;
create policy bot_playbooks_worker on bot_playbooks to openedbot_worker
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

drop policy if exists message_reactions_worker on message_reactions;
drop policy if exists support_messages_worker on support_messages;
revoke all on message_reactions, support_messages from openedbot_worker;

insert into schema_migrations(version) values ('0082_worker_tenant_scope') on conflict (version) do nothing;

commit;
