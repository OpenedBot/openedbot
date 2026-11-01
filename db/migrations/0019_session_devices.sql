begin;

-- Écran « Sécurité du compte » : lister ses propres sessions et révoquer
-- celles qu'on ne reconnaît pas.
--
-- La seule policy existante sur `sessions` (`sessions_credential`,
-- 0001_tenancy_auth.sql) n'ouvre que trois portes de type *_hash : elle sert
-- à retrouver LA session courante depuis son jeton, jamais à en LISTER
-- plusieurs. Sous `withTenant`, un `select ... where organization_id = $1`
-- renvoie donc toujours 0 ligne, même pour le propriétaire des sessions.
--
-- La porte ajoutée ici est l'utilisateur (`app.authenticating_user_id`), pas
-- l'organisation (`app.organization_id`) : le mot de passe et les sessions
-- sont une propriété de l'utilisateur, pas de l'organisation courante : un
-- membre ne doit jamais pouvoir lister les sessions d'un autre membre du
-- même tenant. Ces policies sont permissives et s'OR-ent avec
-- `sessions_credential` : elles ne la remplacent pas et ne retirent aucun
-- accès existant.
alter table sessions
  add column user_agent text,
  add column ip inet,
  add column family_id uuid,
  add column revoked_reason text
    check (revoked_reason is null
      or revoked_reason in ('logout', 'user_revoked', 'password_change', 'refresh_rotation'));

-- Rien n'indexait `user_id` : la liste « mes sessions, les plus récentes
-- d'abord » ferait un scan complet de la table sans cet index.
create index sessions_owner_idx on sessions (user_id, created_at desc);

create policy sessions_owner_read on sessions
  for select to ohb_api
  using (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid);

-- `for update`, pas `for all` : cette porte ne doit ouvrir ni `insert` ni
-- `delete`, seulement la révocation (un update sur `revoked_at`).
create policy sessions_owner_revoke on sessions
  for update to ohb_api
  using (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid);

insert into schema_migrations(version) values ('0019_session_devices')
on conflict (version) do nothing;

commit;
