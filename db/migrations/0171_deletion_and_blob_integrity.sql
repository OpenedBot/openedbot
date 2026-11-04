-- Intégrité des suppressions et des octets.
begin;

-- 1. Les octets d'un envoi sans Idempotency-Key.
--
-- L'API inscrit les clés de l'envoi dans `tenant_blob_deletions` AVANT
-- l'upload, avec un délai, puis retire ces lignes dans la transaction qui
-- écrit `attachments`. Un commit dont l'accusé s'est perdu ne fait donc plus
-- supprimer des objets référencés, et un rollback ne laisse plus d'orphelin
-- introuvable. La policy reste bornée aux clés `org/` de l'organisation de la
-- transaction : l'API ne voit ni les clés d'un autre tenant ni celles du
-- guichet par cette porte.
create policy tenant_blob_reservations_api on tenant_blob_deletions to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and object_key like ('org/' || organization_id::text || '/%')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and object_key like ('org/' || organization_id::text || '/%')
  );

-- 2. La suppression du profil hôte d'un bot (DELETE /profiles/:slug et jobs).
--
-- Entre la vérification qu'aucun run n'est actif et la suppression finale du
-- bot, il y a des appels à l'hôte : un nouveau message pouvait y créer un run
-- que la cascade emportait ensuite. Cet état durable dit « suppression
-- engagée » ; il implique l'archivage, que toutes les admissions refusent
-- déjà (`archived_at is null`). Il sert aussi de preuve à une reprise : un
-- profil absent de l'hôte et un bot marqué, c'est une suppression distante
-- réussie dont la finalisation locale reste à faire.
alter table bots add column host_profile_deleting_at timestamptz;
alter table bots add constraint bots_host_profile_deleting_implies_archived
  check (host_profile_deleting_at is null or archived_at is not null);
comment on column bots.host_profile_deleting_at is
  'Suppression du profil hôte engagée : le bot reste archivé (contrainte bots_host_profile_deleting_implies_archived) jusqu''à sa suppression ; une reprise qui trouve le profil absent finalise le nettoyage local.';

-- 3. Le retrait distant d'une publication révoquée.
--
-- La révocation se commitait dans la transaction qui appelait Cloudflare ou
-- Tailscale : une suppression distante réussie puis un échec annulaient la
-- révocation en base, et un runtime restait déclaré vers un tunnel disparu.
-- La révocation est désormais commitée seule, avec ce qui reste à retirer ;
-- les suppressions idempotentes suivent hors transaction. `pending` se
-- reprend (worker pour un tunnel géré, nouveau DELETE pour Funnel), `done`
-- est fait, `manual` reste au propriétaire ; null : rien à retirer.
alter table runtime_direct_exposures add column cleanup_status text
  constraint runtime_direct_exposures_cleanup_status_check
  check (cleanup_status in ('pending', 'done', 'manual'));
create index runtime_direct_exposures_cleanup_idx on runtime_direct_exposures (last_checked_at asc nulls first)
  where kind = 'managed_cloudflare' and status = 'revoked' and cleanup_status = 'pending';

-- 4. L'effacement d'un compte qui garde des adhésions révoquées.
--
-- L'éligibilité ignore les adhésions révoquées ; l'effacement exigeait qu'il
-- n'en reste AUCUNE, et laissait donc l'adresse et les moyens de connexion
-- alors que le courriel de confirmation partait. Une adhésion révoquée ne se
-- supprime pas : elle ancre l'historique d'un autre tenant (décisions,
-- invitations, sans cascade) ou en emporterait des lignes. Le compte est
-- donc supprimé quand plus rien ne le référence, pseudonymisé sinon.
--
-- Le worker n'a ni UPDATE sur `users` ni aucun droit sur `sessions` (0080) :
-- il appelle cette fonction, qui n'agit que sur un compte sans adhésion vivante.
create or replace function public.erase_account_user(p_user_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    return 'absent';
  end if;
  if exists (select 1 from public.memberships m where m.user_id = p_user_id and m.revoked_at is null) then
    return 'kept';
  end if;
  if not exists (select 1 from public.memberships m where m.user_id = p_user_id) then
    delete from public.users where id = p_user_id;
    return 'deleted';
  end if;
  update public.users
     set email = 'erased+' || p_user_id::text || '@erased.invalid',
         password_hash = null,
         google_subject = null,
         display_name = null,
         updated_at = pg_catalog.now()
   where id = p_user_id;
  delete from public.sessions where user_id = p_user_id;
  delete from public.native_auth_codes where user_id = p_user_id;
  delete from public.mobile_connect_tickets where user_id = p_user_id;
  delete from public.account_preferences where user_id = p_user_id;
  return 'pseudonymized';
end;
$$;

do $owner$
declare
  migrator name;
begin
  select t.tableowner into migrator
    from pg_catalog.pg_tables t
   where t.schemaname = 'public' and t.tablename = 'users';
  if migrator in ('ohb_api', 'ohb_worker', 'ohb_staff') then
    raise exception 'erase_account_user: % is an application role, not the migration role', migrator;
  end if;
  execute pg_catalog.format('alter function public.erase_account_user(uuid) owner to %I', migrator);
end;
$owner$;

revoke all on function public.erase_account_user(uuid) from public;
grant execute on function public.erase_account_user(uuid) to ohb_worker;

comment on function public.erase_account_user(uuid) is
  'Account purge: deletes a user without any membership, pseudonymizes one that only keeps revoked memberships (history of other tenants), keeps one with a live membership. ohb_worker only.';

-- 5. L'acteur d'un envoi, d'un workflow ou d'une routine, sous mandat d'agence.
--
-- Depuis 0086, un opérateur d'agence agit chez un client SANS adhésion dans
-- ce tenant (`workspace_access`, rôle dérivé `agency`). Ces colonnes d'acteur
-- référençaient pourtant `memberships(organization_id, user_id)` : l'envoi
-- d'un DM, l'ouverture d'un workflow, une soumission idempotente ou une
-- routine échouaient en 23503. L'acteur référence désormais `users(id)`,
-- comme `bot_permission_tool_policies` (0141) ; l'accès reste vérifié par
-- l'application avant l'écriture, et les FK composites des ressources
-- (fil, bot, run) ne changent pas. Les FK sont retrouvées par ce qu'elles
-- relient, pas par un nom généré.
do $actors$
declare
  target record;
  fk name;
begin
  for target in
    select * from (values
      ('runs', 'initiator_user_id'),
      ('workflows', 'initiator_user_id'),
      ('message_ingress', 'user_id'),
      ('routines', 'created_by_user_id')
    ) as actor(table_name, column_name)
  loop
    for fk in
      select con.conname
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class rel on rel.oid = con.conrelid
        join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
       where ns.nspname = 'public' and rel.relname = target.table_name
         and con.contype = 'f' and con.confrelid = 'public.memberships'::regclass
         and exists (
           select 1 from pg_catalog.unnest(con.conkey) k(attnum)
             join pg_catalog.pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
            where att.attname = target.column_name
         )
    loop
      execute pg_catalog.format('alter table public.%I drop constraint %I', target.table_name, fk);
    end loop;
  end loop;
end;
$actors$;

-- Chaque valeur existante nommait une adhésion, donc un compte : les
-- nouvelles FK se valident sans réécrire de ligne.
alter table runs add constraint runs_initiator_user_fkey
  foreign key (initiator_user_id) references users(id) on delete set null;
alter table workflows add constraint workflows_initiator_user_fkey
  foreign key (initiator_user_id) references users(id) on delete set null;
alter table message_ingress add constraint message_ingress_user_fkey
  foreign key (user_id) references users(id) on delete cascade;
alter table routines add constraint routines_created_by_user_fkey
  foreign key (created_by_user_id) references users(id) on delete set null;

-- 6. L'agence auteur d'une politique d'outil, après la purge de l'agence.
--
-- `updated_by_agency_organization_id` passait à null par `on delete set null`
-- alors que `updated_by_kind` restait `agency` : le CHECK
-- `bot_permission_tool_policies_agency_actor_check` annulait la purge entière
-- de l'agence, rejouée jusqu'au plafond de tentatives. L'identifiant reste une
-- trace historique, sans FK : la purge d'une agence ne touche plus les
-- politiques de ses clients, et le CHECK reste vrai.
do $agency_actor$
declare
  fk name;
begin
  for fk in
    select con.conname
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
     where con.conrelid = 'public.bot_permission_tool_policies'::regclass
       and con.contype = 'f' and con.confrelid = 'public.organizations'::regclass
       and att.attname = 'updated_by_agency_organization_id'
  loop
    execute pg_catalog.format('alter table public.bot_permission_tool_policies drop constraint %I', fk);
  end loop;
end;
$agency_actor$;

comment on column bot_permission_tool_policies.updated_by_agency_organization_id is
  'Agence qui a écrit la politique, quand updated_by_kind = agency. Trace historique sans FK (0171) : elle survit à la purge de l''agence.';

-- 7. Le magasin de chaque objet à supprimer.
--
-- Une bascule disque ↔ R2 changeait le magasin de TOUTES les suppressions :
-- une clé écrite sur le disque était « supprimée » sur R2 (succès d'un DELETE
-- sans objet) et ses octets restaient. Chaque ligne porte désormais le driver
-- que l'objet a persisté (`attachments.driver`, `support_attachments.driver`)
-- et le worker supprime là, ou réessaie si ce magasin n'est pas joignable.
-- null : ligne d'avant cette migration ou clé sans driver connu (manifeste
-- d'ingestion), supprimée dans chaque magasin joignable.
alter table tenant_blob_deletions add column driver text
  constraint tenant_blob_deletions_driver_check check (driver in ('file', 'r2'));

insert into schema_migrations(version) values ('0171_deletion_and_blob_integrity')
on conflict (version) do nothing;

commit;
