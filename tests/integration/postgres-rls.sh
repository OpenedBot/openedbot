#!/usr/bin/env bash
set -euo pipefail

# Piège de ce fichier : chaque preuve est un heredoc DANS une substitution de
# commande `$( … )`. Une apostrophe isolée dans le corps du heredoc, y compris
# dans un commentaire SQL, casse l analyse de bash au fichier entier
# (« unexpected EOF while looking for matching `'"'"'` »). Écrire ces
# commentaires sans apostrophe.

container="${OPENEDBOT_POSTGRES_CONTAINER:-infra-postgres}"
database="${OPENEDBOT_INTEGRATION_DATABASE:-ohb_integration}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
database_url="${INTEGRATION_DATABASE_URL:-}"
admin_url="${INTEGRATION_ADMIN_DATABASE_URL:-}"

# Les tables ou ohb_worker lit toutes les organisations (policy using (true)),
# puis le nombre de tables retirees au worker par 0080, 0082, 0148 et 0154. Retirer une table de
# cette liste est le but ; en ajouter une demande une raison dans le commit.
# organization_permission_policies (0142) : plafond et liste d interdiction de
# l organisation, lus par le pipeline du worker en SELECT seul, filtre explicite.
# runtime_review_profiles (0139) : preuve par runtime du profil de revue, ecrite
# par le worker seul, sans secret ni texte libre.
# alert_deliveries (0157) : file de reclamation des alertes Discord, sans secret ;
# alert_channels, qui porte le webhook chiffre, reste sous tenant.
# apns_deliveries (0108) : file de reclamation APNs, comme push_deliveries, sans
# secret ni texte ; apns_devices, qui porte le token chiffre, reste sous tenant.
# audit_chain et audit_worm_orphans (0154) : ni SELECT ni policy worker,
# comptees dans les tables retirees. Le payload de la chaine est en clair et
# reason porte un texte d erreur libre : le worker ne lit plus l audit de
# toutes les organisations ; la purge passe par audit_chain_for_purge(org).
worker_policy_exceptions_expected="alert_deliveries,apns_deliveries,approval_requests,attachments,bot_groups,bot_host_cleanups,bot_profile_provisions,bots,email_outbox,group_member_read_positions,group_members,memberships,message_ingress,message_versions,messages,operator_profiles,organization_permission_policies,organizations,profile_delete_jobs,profile_import_items,profile_import_jobs,push_deliveries,push_outbox,push_subscriptions,routine_executions,routines,run_events,run_steering_attempts,runs,runtime_bot_settings_tools,runtime_connector_notices,runtime_direct_exposures,runtime_enrollments,runtime_link_alerts,runtime_link_events,runtime_model_selection_proofs,runtime_review_profiles,runtime_routine_tools,runtimes,sections,subscriptions,support_attachments,support_conversations,support_events,tenant_blob_deletions,tenant_deletions,thread_message_counters,threads,tool_errors,workflows|10"

# Preuve 0154 : audit_chain_for_purge(org), seul acces worker a la chaine.
# Proprietaire ohb_migrator (BYPASSRLS), SECURITY DEFINER, STABLE, search_path
# fige ; aucun EXECUTE pour PUBLIC, ohb_api ni ohb_staff ; org A ne rend rien
# de B, NULL refuse en 22004, table directe et appel API refuses en 42501.
purge_fn_expected="ohb_migrator/true/true/s/search_path=pg_catalog, pg_temp|false/false/false/true|api_call=42501,worker_a=2/0,worker_null=22004,worker_table=42501"

# Preuve 0092 : etape de workflow, DM, identite forgee ecrasee, bail perime,
# rejeu sans doublon, ecriture API estampillee, puis rien pour un autre tenant.
run_events_identity_expected="step/dm/overwritten/denied/1/91000000-0000-4000-8000-000000000043|0/0"

if [[ "$database" != "ohb_integration" ]]; then
  printf 'Refusing integration database outside the exact disposable target.\n' >&2
  exit 1
fi
if [[ -n "$database_url" || -n "$admin_url" ]]; then
  if [[ -z "$database_url" || -z "$admin_url" ]]; then
    printf 'INTEGRATION_DATABASE_URL and INTEGRATION_ADMIN_DATABASE_URL must be provided together.\n' >&2
    exit 1
  fi

  cleanup() {
    psql -v ON_ERROR_STOP=1 -v database_name="$database" "$admin_url" <<'SQL' >/dev/null
select pg_terminate_backend(pid) from pg_stat_activity
 where datname = :'database_name' and pid <> pg_backend_pid();
select format('drop database if exists %I', :'database_name')\gexec
SQL
  }
  trap cleanup EXIT
  cleanup

  psql -v ON_ERROR_STOP=1 -v database_name="$database" "$admin_url" <<'SQL' >/dev/null
do $$
begin
  if not exists (select from pg_roles where rolname = 'ohb_migrator') then
    create role ohb_migrator nologin nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'ohb_api') then
    create role ohb_api login password 'ohb_api_dev' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = 'ohb_worker') then
    create role ohb_worker login password 'ohb_worker_dev' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = 'ohb_staff') then
    create role ohb_staff login password 'ohb_staff_dev' nosuperuser nocreatedb nocreaterole;
  end if;
end $$;
alter role ohb_migrator nologin nosuperuser nocreatedb nocreaterole bypassrls;
select format('create database %I owner ohb_migrator', :'database_name')\gexec
select format('grant connect on database %I to ohb_api, ohb_worker, ohb_staff', :'database_name')\gexec
SQL

  for migration in "$root"/db/migrations/*.sql; do
    PGOPTIONS='-c role=ohb_migrator' \
      psql -v ON_ERROR_STOP=1 "$database_url" -f "$migration" >/dev/null
  done

  # `-At` sans `-q` laisse passer les étiquettes de commande (INSERT 0 2,
  # SET), et `select set_config(...)` renvoie sa propre ligne : sans filtrage,
  # $proof ne peut jamais égaler les quatre lignes attendues. Même traitement
  # que operational_metrics et invited plus bas : ne garder que les dernières
  # lignes, celles des select finaux.
  proof="$(psql -v ON_ERROR_STOP=1 -At "$database_url" <<'SQL' | tail -n 4
insert into organizations (id, slug, name) values
  ('10000000-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A'),
  ('20000000-0000-4000-8000-000000000002', 'tenant-b', 'Tenant B');
insert into sections (id, organization_id, name, position) values
  ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'Section A', 0),
  ('20000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002', 'Section B', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'Bot A', 'bot-a', 'profile-a', 0),
  ('20000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000012', 'Bot B', 'bot-b', 'profile-b', 0);
set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false);
select count(*) from organizations;
select count(*) from organizations where id = '20000000-0000-4000-8000-000000000002';
select count(*) from bots;
select count(*) from bots where organization_id = '20000000-0000-4000-8000-000000000002';
SQL
)"
  if [[ "$proof" != $'1\n0\n1\n0' ]]; then
    printf 'RLS proof failed; expected org=1/0 and bot=1/0, got:\n%s\n' "$proof" >&2
    exit 1
  fi

  staff_cross_tenant="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/staff-cross-tenant.sql")"
  if [[ "$staff_cross_tenant" != "1/0/denied/2/login" ]]; then
    printf 'Staff cross-tenant proof failed; expected tenant RLS 1/0, function denied without staff GUC, both tenants with staff GUC, and ohb_staff canlogin, got:\n%s\n' "$staff_cross_tenant" >&2
    exit 1
  fi

  staff_runtime_connectors="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/staff-runtime-connectors.sql")"
  if [[ "$staff_runtime_connectors" != "denied/Old host,Silent host/owner-a@connectors.test/edge-setup/v0.5.3/true,false" ]]; then
    printf 'Staff runtime connectors proof failed; expected denied without staff GUC, live non-revoked connectors of live tenants with owner, agent and link, got:\n%s\n' "$staff_runtime_connectors" >&2
    exit 1
  fi

  support_desk="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/support-desk.sql")"
  if [[ "$support_desk" != "1/1/1/0/denied/0/0/4/2/1/1/0/0" ]]; then
    printf 'Support desk proof failed; expected guest A to see only its own thread (1/1/1/0), a cross write denied, nothing without a gate or with an unknown staff id (0/0), a live staff session to see all four threads with two messages and one notice recipient (4/2/1), and the account door to see its own thread only, never the anonymous one nor another account (1/0/0), got:\n%s\n' "$support_desk" >&2
    exit 1
  fi

  # Cette preuve reproduit le propriétaire NOSUPERUSER de production. Elle
  # vérifie le BYPASSRLS qui permet aux gardes SECURITY DEFINER de lire
  # staff_users, tout en appelant réellement les fonctions avec ohb_api.
  staff_definer_owner="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" <<'SQL'
create temp table staff_owner_proof (counts_rows int);
insert into staff_owner_proof values (-1);
grant select, update on staff_owner_proof to ohb_api;
set role ohb_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000081', false) \g /dev/null
do $proof$
begin
  update staff_owner_proof set counts_rows = (select count(*) from staff_user_counts());
exception when others then
  null;
end;
$proof$;
reset role;
select pg_get_userbyid(p.proowner) || '/' || r.rolbypassrls::text || '/'
       || s.counts_rows
  from pg_proc p
  join pg_roles r on r.rolname = pg_get_userbyid(p.proowner)
 cross join staff_owner_proof s
 where p.oid = 'staff_user_counts()'::regprocedure;
SQL
)"
  if [[ "$staff_definer_owner" != "ohb_migrator/true/1" ]]; then
    printf 'Staff SECURITY DEFINER proof failed; expected ohb_migrator/true and one row from counts, got:\n%s\nProbable cause: the schema owner is not exempt from RLS.\n' "$staff_definer_owner" >&2
    exit 1
  fi

  operational_metrics="$(psql -v ON_ERROR_STOP=1 -At "$database_url" <<'SQL' | tail -n 3
set role ohb_api;
select count(*) from internal_operational_metrics();
select has_function_privilege(current_user, 'internal_operational_metrics()', 'execute');
select has_function_privilege('ohb_worker', 'internal_operational_metrics()', 'execute');
SQL
)"
  if [[ "$operational_metrics" != $'1\nt\nf' ]]; then
    printf 'Operational metrics privilege proof failed; expected one aggregate row, API EXECUTE and no worker EXECUTE, got:\n%s\n' "$operational_metrics" >&2
    exit 1
  fi

  invited="$(psql -v ON_ERROR_STOP=1 -At "$database_url" <<'SQL' | tail -n 3
insert into users (id, email) values
  ('30000000-0000-4000-8000-000000000031', 'owner-a@example.test'),
  ('30000000-0000-4000-8000-000000000032', 'owner-b@example.test');
insert into memberships (organization_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031', 'owner'),
  ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000032', 'owner');
insert into agency_client_invitations (id, agency_organization_id, email, token_hash, invited_by_user_id, expires_at) values
  ('40000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000001', 'invited@example.test', 'hash-a', '30000000-0000-4000-8000-000000000031', now() + interval '7 days'),
  ('40000000-0000-4000-8000-000000000042', '20000000-0000-4000-8000-000000000002', 'ailleurs@example.test', 'hash-b', '30000000-0000-4000-8000-000000000032', now() + interval '7 days');
set role ohb_api;
select set_config('app.agency_invitation_hash', 'hash-a', false);
select count(*) from agency_client_invitations;
select count(*) from organizations;
select count(*) from bots;
SQL
)"
  if [[ "$invited" != $'1\n0\n0' ]]; then
    printf 'Invitation-token RLS proof failed; expected invitation=1 and org/bot=0, got:\n%s\n' "$invited" >&2
    exit 1
  fi

  decision_audit="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/decision-audit-bot-delete.sql")"
  if [[ "$decision_audit" != $'0/0/0/0/1/1/1\n0' ]]; then
    printf 'Decision audit bot deletion proof failed; expected live rows removed, hash-chained decision retained/detached and cross-tenant visibility denied, got:\n%s\n' "$decision_audit" >&2
    exit 1
  fi


  runtime_active="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runtime-active-uniqueness.sql")"
  if [[ "$runtime_active" != "refused/refused/0" ]]; then
    printf 'Runtime activation proof failed; expected a refused second active runtime, a refused revoked-active runtime and no cross-tenant visibility, got:\n%s\n' "$runtime_active" >&2
    exit 1
  fi

  ssh_columns_dropped="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runtime-ssh-columns-dropped.sql")"
  if [[ "$ssh_columns_dropped" != "3/0/0/idempotent" ]]; then
    printf 'OHB-15 schema proof failed; expected the three SSH columns to exist, disappear with their constraints and survive a replay, got:\n%s\n' "$ssh_columns_dropped" >&2
    exit 1
  fi

  organization_slugs="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/organization-slugs.sql" | tail -n 1)"
  if [[ "$organization_slugs" != "acme-sas-000000000001/client-emilie/acme-sas/bad/slug-ok/refused/refused/stable" ]]; then
    printf 'Organization slug proof failed; expected legacy slugs normalized without touching valid ones, malformed and UUID-shaped slugs refused and a stable replay, got:\n%s\n' "$organization_slugs" >&2
    exit 1
  fi

  runtime_reachability="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runtime-reachability.sql")"
  if [[ "$runtime_reachability" != "refused/refused/refused/refused/1/0/visible/1" ]]; then
    printf 'Runtime reachability proof failed; expected the three malformed runtime shapes and the connector enrollment with an URL refused, exactly one row behind the link credential, none without it, link_last_seen_at readable by the worker and toolset_epoch bumped by the tenant and read by the worker, got:\n%s\n' "$runtime_reachability" >&2
    exit 1
  fi

  runtime_read_snapshots="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runtime-read-snapshots.sql")"
  if [[ "$runtime_read_snapshots" != "isolated/api-only" ]]; then
    printf 'Runtime read snapshot RLS proof failed; expected tenant isolation and API-only access, got:\n%s\n' "$runtime_read_snapshots" >&2
    exit 1
  fi

  enrollment_isolation="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runtime-enrollment-isolation.sql")"
  if [[ "$enrollment_isolation" != "0/1/0" ]]; then
    printf 'Runtime enrollment isolation proof failed; expected invisible without the secret, visible with it and invisible from another tenant, got:\n%s\n' "$enrollment_isolation" >&2
    exit 1
  fi

  session_visibility="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/session-visibility.sql")"
  if [[ "$session_visibility" != "0/1/0/0" ]]; then
    printf 'Session visibility proof failed; expected zero by tenant alone, one for the owner, zero for another user and zero rows revoked by another user, got:\n%s\n' "$session_visibility" >&2
    exit 1
  fi

  push_subscriptions="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/push-subscriptions.sql")"
  if [[ "$push_subscriptions" != "1/0/0" ]]; then
    printf 'Push subscriptions proof failed; expected own=1, other tenant=0, cascade purge=0, got:\n%s\n' "$push_subscriptions" >&2
    exit 1
  fi

  connector_release_seen="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/connector-release-seen.sql")"
  if [[ "$connector_release_seen" != "1/0/0" ]]; then
    printf 'Connector release seen proof failed; expected own=1, other member=0, other tenant=0, got:\n%s\n' "$connector_release_seen" >&2
    exit 1
  fi

  provider_incidents="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/provider-incidents.sql")"
  if [[ "$provider_incidents" != "1/0/1/0/0" ]]; then
    printf 'Provider incidents RLS proof failed; expected own=1, other=0, worker under tenant A=1, worker without tenant=0, cascade=0, got:\n%s\n' "$provider_incidents" >&2
    exit 1
  fi

  routine_executions="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/routine-executions.sql")"
  if [[ "$routine_executions" != "1/0/0" ]]; then
    printf 'Routine executions proof failed; expected own=1, other tenant=0, cascade=0, got:\n%s\n' "$routine_executions" >&2
    exit 1
  fi

  routine_group="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/routine-group.sql")"
  if [[ "$routine_group" != "refused/refused/1/0" ]]; then
    printf 'Routine group xor/RLS proof failed; expected refused/refused/1/0, got:\n%s\n' "$routine_group" >&2
    exit 1
  fi

  # PERM2-1 (0138) : revision du bot, bascule staff gardee (worker sans v2,
  # run en vol), garde du worker ancien en v2, retour legacy vers un humain.
  permission_pipeline="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/permission-pipeline.sql" | tail -n 1)"
  permission_pipeline_expected="1|refused|workers_not_ready|runs_in_flight|switched:legacy>v2|unchanged|2|refused|awaiting_human|ready|switched:1|pending/pending/awaiting_human/-/-|3|null"
  if [[ "$permission_pipeline" != "$permission_pipeline_expected" ]]; then
    printf 'Permission pipeline proof failed; expected %s, got:\n%s\n' "$permission_pipeline_expected" "$permission_pipeline" >&2
    exit 1
  fi

  # Onboarding par personne (0025) : la colonne vaut false par defaut, et le
  # backfill pose true au membre d un espace deja onboarde, false a l autre.
  # Le rejeu retire la colonne et sa ligne schema_migrations puis applique le
  # fichier livre tel quel : la preuve porte sur le SQL de la migration, pas
  # sur une copie. ohb_api (sans GUC, users n est pas sous RLS) peut ensuite
  # remettre le flag a false : le chemin du reset de developpement.
  psql -v ON_ERROR_STOP=1 -q "$database_url" <<'SQL' >/dev/null
update organizations set onboarded_at = now() where id = '10000000-0000-4000-8000-000000000001';
alter table users drop column onboarding_completed;
delete from schema_migrations where version = '0025_user_onboarding_completed';
SQL
  psql -v ON_ERROR_STOP=1 "$database_url" -f "$root/db/migrations/0025_user_onboarding_completed.sql" >/dev/null
  user_onboarding="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" <<'SQL'
update organizations set onboarded_at = null where id = '10000000-0000-4000-8000-000000000001';
select (select onboarding_completed from users where id = '30000000-0000-4000-8000-000000000031')::text
  || '/' || (select onboarding_completed from users where id = '30000000-0000-4000-8000-000000000032')::text
  || '/' || (select column_default from information_schema.columns
              where table_name = 'users' and column_name = 'onboarding_completed');
set role ohb_api;
update users set onboarding_completed = false where id = '30000000-0000-4000-8000-000000000031';
select onboarding_completed::text from users where id = '30000000-0000-4000-8000-000000000031';
reset role;
SQL
)"
  if [[ "$user_onboarding" != $'true/false/false\nfalse' ]]; then
    printf 'User onboarding flag proof failed; expected backfill true/false with default false, then false after the ohb_api reset, got:\n%s\n' "$user_onboarding" >&2
    exit 1
  fi

# Playbooks structurés : même cloisonnement tenant que les bots, cascade avec
  # l organisation.
  playbooks="$(psql -v ON_ERROR_STOP=1 -At "$database_url" <<'SQL' | tail -n 1
create temp table playbook_proof (own int, other int);
grant insert, update, select on playbook_proof to ohb_api;
insert into playbooks (id, organization_id, key, name) values
  ('50000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000001', 'brief', 'Brief A'),
  ('50000000-0000-4000-8000-000000000062', '20000000-0000-4000-8000-000000000002', 'brief', 'Brief B');
insert into bot_playbooks (organization_id, bot_id, playbook_id) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000061'),
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000022', '50000000-0000-4000-8000-000000000062');
set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false);
insert into playbook_proof (own, other)
  select (select count(*) from playbooks),
         (select count(*) from playbooks where organization_id = '20000000-0000-4000-8000-000000000002');
reset role;
select own || '/' || other from playbook_proof;
SQL
)"
  if [[ "$playbooks" != "1/0" ]]; then
    printf 'Playbook RLS proof failed; expected 1/0 (own visible, other hidden), got:\n%s\n' "$playbooks" >&2
    exit 1
  fi

  # Marketplace (0103) : modeles d organisation cloisonnes par tenant, aucun
  # acces worker, catalogue officiel lu par l API et jamais supprime.
  marketplace="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/marketplace.sql" | tail -n 1)"
  if [[ "$marketplace" != "on/1/0/denied/0/0/denied/1/denied" ]]; then
    printf 'Marketplace RLS proof failed; expected forced RLS, own template visible and the other hidden, cross-tenant insert denied, cross-tenant update matching nothing, nothing without a tenant, no worker access, the official entry readable and its delete denied, got:\n%s\n' "$marketplace" >&2
    exit 1
  fi

  api_instances="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/api-instances.sql")"
  if [[ "$api_instances" != "off/1/1/denied" ]]; then
    printf 'API instances proof failed; expected no RLS, API write, worker read, worker insert denied, got:\n%s\n' "$api_instances" >&2
    exit 1
  fi

  email_outbox="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/email-outbox-api.sql" | tail -n 1)"
  if [[ "$email_outbox" != "inserted/denied/denied/1" ]]; then
    printf 'Email outbox proof failed; expected API insert, API read denied, API update denied, worker read, got:\n%s\n' "$email_outbox" >&2
    exit 1
  fi

  # La porte du produit (0068) : l API valide une adresse, la lecture
  # d authentification ne voit que les adresses validees, et les deux colonnes
  # de la validation ne se separent jamais.
  waitlist_access="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/waitlist-access.sql" | tail -n 1)"
  if [[ "$waitlist_access" != "granted|alpha|none|refused|refused|refused|none|3/refused|none|refused|refused|refused" ]]; then
    printf 'Waitlist access proof failed; expected API grant, gate open for the approved address only, solidary columns, revocation, a bounded account tier and a rejection the gate ignores and the approval cannot overwrite, got:\n%s\n' "$waitlist_access" >&2
    exit 1
  fi

  # Pagination keyset, echappement du like, bornes et garde 42501 des fonctions
  # de 0059. Placée ici : la preuve insere une organisation et 254 comptes, elle
  # ne doit précéder aucun comptage global, et la preuve de memoire qui suit
  # supprime le tenant A.
  staff_user_paging="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/staff-user-paging.sql")"
  if [[ "$staff_user_paging" != "2|2|0|4|4|2|p-gamma@paging.test|p_beta@paging.test|0|p-alpha@paging.test|200|1|true/true|thread/Alpha/Paging Org|0|denied|denied|denied|denied" ]]; then
    printf 'Staff user paging proof failed; expected two disjoint keyset pages, escaped like, capped bounds, a thread resolved without its title and 42501 without a live staff GUC, got:\n%s\n' "$staff_user_paging" >&2
    exit 1
  fi

  # Cadrage et garde de staff_audit_scope (0060) : un tenant demandé ne rend
  # que lui, un sujet traverse les tenants, un appel sans cadre est refusé.
  # Ses identifiants d'audit sont détachés, elle ne dépend d'aucune autre preuve.
  staff_audit_scope="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/staff-audit-scope.sql")"
  if [[ "$staff_audit_scope" != "2|0|2|1|3|42501|42501|22023" ]]; then
    printf 'Staff audit scope proof failed; expected the asked tenant only, a subject across tenants, the actor branch, 42501 without a live staff GUC and 22023 without a scope, got:\n%s\n' "$staff_audit_scope" >&2
    exit 1
  fi

  # Destinataires de l'avis de fermeture (0149) : chaque compte une fois, le
  # total de la table meme sous une borne, le genre de la file, et la garde.
  closure_notice="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/closure-notice-recipients.sql")"
  if [[ "$closure_notice" != "true/true/true/1|1/true|account_closure_notice|denied|denied" ]]; then
    printf 'Closure notice recipients proof failed; expected every account once with the table total, a bound that cuts rows but never the total, the new outbox kind and 42501 without a live staff GUC, got:\n%s\n' "$closure_notice" >&2
    exit 1
  fi

  # Le geste du support (0071) : nouveau hachage, drapeau leve, sessions du
  # compte fermees et voisin intact, les deux refus sans ecriture, et les deux
  # gardes de la fonction. Elle insere ses propres espaces et comptes, donc
  # elle vient en DERNIER : aucun comptage global ne la suit.
  staff_password_reset="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/staff-password-reset.sql" | tail -n 1)"
  if [[ "$staff_password_reset" != "reset|replaced|raised|2|password_change|1|google_only|none|no_organization|kept|0|42501|22023" ]]; then
    printf 'Staff password reset proof failed; expected a full reset with its sessions closed, an untouched neighbour, both refusals writing nothing, 42501 without a live staff GUC and 22023 on a short hash, got:\n%s\n' "$staff_password_reset" >&2
    exit 1
  fi

  # Les policies ohb_worker en using (true) sont une liste figee (0080) : une
  # nouvelle table ouverte a toutes les organisations est une decision.
  worker_policy_exceptions="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/worker-policy-exceptions.sql")"
  if [[ "$worker_policy_exceptions" != "$worker_policy_exceptions_expected" ]]; then
    printf 'Worker policy exceptions proof failed; expected the frozen using (true) list and every revoked table, got:\n%s\nexpected:\n%s\n' "$worker_policy_exceptions" "$worker_policy_exceptions_expected" >&2
    exit 1
  fi

  # 0154 : la seule lecture worker de audit_chain, une organisation a la fois.
  purge_fn="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/audit-chain-for-purge.sql" | tail -n 1)"
  if [[ "$purge_fn" != "$purge_fn_expected" ]]; then
    printf 'audit_chain_for_purge proof failed; got:\n%s\nexpected:\n%s\n' "$purge_fn" "$purge_fn_expected" >&2
    exit 1
  fi

  # Un run termine ne change plus de statut (0081), un run annule si.
  runs_final_status="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/runs-final-status.sql" | tail -n 1)"
  if [[ "$runs_final_status" != "denied/denied/queued/final/completed" ]]; then
    printf 'Runs final status proof failed; expected completed and failed runs to keep their status, a cancelled run to requeue, other columns writable and running to complete, got:\n%s\n' "$runs_final_status" >&2
    exit 1
  fi

  # Identite et fencing de run_events (0092) : estampille depuis le run, bail
  # perime refuse, rejeu absorbe, RLS tenant inchangee.
  run_events_identity="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/run-events-identity.sql" | tail -n 1)"
  if [[ "$run_events_identity" != "$run_events_identity_expected" ]]; then
    printf 'Run events identity proof failed; expected identity stamped from the run, a stale lease refused, a replay absorbed and tenant isolation, got:\n%s\nexpected:\n%s\n' "$run_events_identity" "$run_events_identity_expected" >&2
    exit 1
  fi

  # La derniere connexion (0075) : aucun remplissage retroactif, ecriture sous
  # ohb_api, rien de deduit de sessions.last_seen_at, et la colonne rendue par
  # la page comme par la fiche. Elle insere son propre espace et ses comptes,
  # donc elle vient apres tout comptage global.
  last_login="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" \
    -f "$root/tests/integration/last-login.sql" | tail -n 1)"
  if [[ "$last_login" != "null|written|null|2026-05-04 08:09:10|null|match|null" ]]; then
    printf 'Last login proof failed; expected no backfill, an API write, nothing derived from session activity, and the column served by staff_search_users and staff_get_user, got:\n%s\n' "$last_login" >&2
    exit 1
  fi


  printf 'PostgreSQL migration and tenant RLS proof passed.\n'
  provision_rls="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" < "$root/tests/integration/bot-profile-provisions.sql" | tail -n 1)"
  if [[ "$provision_rls" != "isolated/forced" ]]; then
    printf 'Bot profile provision RLS proof failed: %s\n' "$provision_rls" >&2
    exit 1
  fi
  model_proof_rls="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" < "$root/tests/integration/runtime-model-selection-proofs.sql" | tail -n 1)"
  if [[ "$model_proof_rls" != "isolated/forced" ]]; then
    printf 'Runtime model selection proof RLS failed: %s\n' "$model_proof_rls" >&2
    exit 1
  fi
  cleanup_rls="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" < "$root/tests/integration/bot-host-cleanups.sql" | tail -n 1)"
  if [[ "$cleanup_rls" != "isolated/forced" ]]; then
    printf 'Bot host cleanup RLS proof failed: %s\n' "$cleanup_rls" >&2
    exit 1
  fi
  creation_requests="$(psql -v ON_ERROR_STOP=1 -qAt "$database_url" < "$root/tests/integration/bot-creation-requests.sql" | tail -n 1)"
  if [[ "$creation_requests" != "scoped/forced" ]]; then
    printf 'Bot creation request proof failed: %s\n' "$creation_requests" >&2
    exit 1
  fi
  exit 0
fi

if ! docker inspect "$container" >/dev/null 2>&1; then
  printf 'PostgreSQL container %s is unavailable.\n' "$container" >&2
  exit 1
fi

cleanup() {
  docker exec "$container" sh -ceu '
    psql -v ON_ERROR_STOP=1 -v database_name="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
select pg_terminate_backend(pid) from pg_stat_activity where datname = :'\''database_name'\'' and pid <> pg_backend_pid();
select format('\''drop database if exists %I'\'', :'\''database_name'\'')\gexec
SQL
  ' -- "$database" >/dev/null
}
trap cleanup EXIT
cleanup

docker exec "$container" sh -ceu '
  psql -v ON_ERROR_STOP=1 -v database_name="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
do \$\$
begin
  if not exists (select from pg_roles where rolname = '\''ohb_migrator'\'') then
    create role ohb_migrator nologin nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = '\''ohb_api'\'') then
    create role ohb_api login password '\''ohb_api_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = '\''ohb_worker'\'') then
    create role ohb_worker login password '\''ohb_worker_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = '\''ohb_staff'\'') then
    create role ohb_staff login password '\''ohb_staff_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
end
\$\$;
alter role ohb_migrator nologin nosuperuser nocreatedb nocreaterole bypassrls;
select format('\''create database %I owner ohb_migrator'\'', :'\''database_name'\'')\gexec
select format('\''grant connect on database %I to ohb_api, ohb_worker, ohb_staff'\'', :'\''database_name'\'')\gexec
SQL
' -- "$database"
# Toutes les migrations, dans l'ordre : une liste tenue à la main finit toujours
# par oublier la dernière, et la preuve tournerait alors sur un schéma périmé.
for migration in "$root"/db/migrations/*.sql; do
  docker exec -i "$container" sh -ceu 'PGOPTIONS="-c role=ohb_migrator" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' -- "$database" \
    < "$migration" >/dev/null
done

proof="$({
  docker exec "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1" <<SQL
insert into organizations (id, slug, name) values
  ('\''10000000-0000-4000-8000-000000000001'\'', '\''tenant-a'\'', '\''Tenant A'\''),
  ('\''20000000-0000-4000-8000-000000000002'\'', '\''tenant-b'\'', '\''Tenant B'\'');
insert into sections (id, organization_id, name, position) values
  ('\''10000000-0000-4000-8000-000000000011'\'', '\''10000000-0000-4000-8000-000000000001'\'', '\''Section A'\'', 0),
  ('\''20000000-0000-4000-8000-000000000012'\'', '\''20000000-0000-4000-8000-000000000002'\'', '\''Section B'\'', 0);
insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
  ('\''10000000-0000-4000-8000-000000000021'\'', '\''10000000-0000-4000-8000-000000000001'\'', '\''10000000-0000-4000-8000-000000000011'\'', '\''Bot A'\'', '\''bot-a'\'', '\''profile-a'\'', 0),
  ('\''20000000-0000-4000-8000-000000000022'\'', '\''20000000-0000-4000-8000-000000000002'\'', '\''20000000-0000-4000-8000-000000000012'\'', '\''Bot B'\'', '\''bot-b'\'', '\''profile-b'\'', 0);
set role ohb_api;
select set_config('\''app.organization_id'\'', '\''10000000-0000-4000-8000-000000000001'\'', false);
select count(*) from organizations;
select count(*) from organizations where id = '\''20000000-0000-4000-8000-000000000002'\'';
select count(*) from bots;
select count(*) from bots where organization_id = '\''20000000-0000-4000-8000-000000000002'\'';
SQL
  ' -- "$database"
} | tail -n 4)"

if [[ "$proof" != $'1\n0\n1\n0' ]]; then
  printf 'RLS proof failed; expected org=1/0 and bot=1/0, got:\n%s\n' "$proof" >&2
  exit 1
fi

staff_cross_tenant="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/staff-cross-tenant.sql")"
if [[ "$staff_cross_tenant" != "1/0/denied/2/login" ]]; then
  printf 'Staff cross-tenant proof failed; expected tenant RLS 1/0, function denied without staff GUC, both tenants with staff GUC, and ohb_staff canlogin, got:\n%s\n' "$staff_cross_tenant" >&2
  exit 1
fi

staff_runtime_connectors="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/staff-runtime-connectors.sql")"
if [[ "$staff_runtime_connectors" != "denied/Old host,Silent host/owner-a@connectors.test/edge-setup/v0.5.3/true,false" ]]; then
  printf 'Staff runtime connectors proof failed; expected denied without staff GUC, live non-revoked connectors of live tenants with owner, agent and link, got:\n%s\n' "$staff_runtime_connectors" >&2
  exit 1
fi

# Cette preuve reproduit le propriétaire NOSUPERUSER de production. Elle
# vérifie le BYPASSRLS qui permet aux gardes SECURITY DEFINER de lire
# staff_users, tout en appelant réellement les fonctions avec ohb_api.
staff_definer_owner="$(docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL'
create temp table staff_owner_proof (counts_rows int);
insert into staff_owner_proof values (-1);
grant select, update on staff_owner_proof to ohb_api;
set role ohb_api;
select set_config('app.staff_user_id', '80000000-0000-4000-8000-000000000081', false) \g /dev/null
do $proof$
begin
  update staff_owner_proof set counts_rows = (select count(*) from staff_user_counts());
exception when others then
  null;
end;
$proof$;
reset role;
select pg_get_userbyid(p.proowner) || '/' || r.rolbypassrls::text || '/'
       || s.counts_rows
  from pg_proc p
  join pg_roles r on r.rolname = pg_get_userbyid(p.proowner)
 cross join staff_owner_proof s
 where p.oid = 'staff_user_counts()'::regprocedure;
SQL
)"
if [[ "$staff_definer_owner" != "ohb_migrator/true/1" ]]; then
  printf 'Staff SECURITY DEFINER proof failed; expected ohb_migrator/true and one row from counts, got:\n%s\nProbable cause: the schema owner is not exempt from RLS.\n' "$staff_definer_owner" >&2
  exit 1
fi

operational_metrics="$(docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL' | tail -n 3
set role ohb_api;
select count(*) from internal_operational_metrics();
select has_function_privilege(current_user, 'internal_operational_metrics()', 'execute');
select has_function_privilege('ohb_worker', 'internal_operational_metrics()', 'execute');
SQL
)"
if [[ "$operational_metrics" != $'1\nt\nf' ]]; then
  printf 'Operational metrics privilege proof failed; expected one aggregate row, API EXECUTE and no worker EXECUTE, got:\n%s\n' "$operational_metrics" >&2
  exit 1
fi

# An invitation hash opens only the matching row, never another tenant.
invited="$(docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL' | tail -n 3
insert into users (id, email) values
  ('30000000-0000-4000-8000-000000000031', 'owner-a@example.test'),
  ('30000000-0000-4000-8000-000000000032', 'owner-b@example.test');
insert into memberships (organization_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000031', 'owner'),
  ('20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000032', 'owner');
insert into agency_client_invitations (id, agency_organization_id, email, token_hash, invited_by_user_id, expires_at) values
  ('40000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000001', 'invited@example.test', 'hash-a', '30000000-0000-4000-8000-000000000031', now() + interval '7 days'),
  ('40000000-0000-4000-8000-000000000042', '20000000-0000-4000-8000-000000000002', 'ailleurs@example.test', 'hash-b', '30000000-0000-4000-8000-000000000032', now() + interval '7 days');
set role ohb_api;
select set_config('app.agency_invitation_hash', 'hash-a', false);
select count(*) from agency_client_invitations;
select count(*) from organizations;
select count(*) from bots;
SQL
)"
if [[ "$invited" != $'1\n0\n0' ]]; then
  printf 'Invitation-token RLS proof failed; expected invitation=1 and org/bot=0, got:\n%s\n' "$invited" >&2
  exit 1
fi

decision_audit="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/decision-audit-bot-delete.sql")"
if [[ "$decision_audit" != $'0/0/0/0/1/1/1\n0' ]]; then
  printf 'Decision audit bot deletion proof failed; expected live rows removed, signed decision retained/detached and cross-tenant visibility denied, got:\n%s\n' "$decision_audit" >&2
  exit 1
fi


runtime_active="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-active-uniqueness.sql")"
if [[ "$runtime_active" != "refused/refused/0" ]]; then
  printf 'Runtime activation proof failed; expected a refused second active runtime, a refused revoked-active runtime and no cross-tenant visibility, got:\n%s\n' "$runtime_active" >&2
  exit 1
fi

ssh_columns_dropped="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-ssh-columns-dropped.sql")"
if [[ "$ssh_columns_dropped" != "3/0/0/idempotent" ]]; then
  printf 'OHB-15 schema proof failed; expected the three SSH columns to exist, disappear with their constraints and survive a replay, got:\n%s\n' "$ssh_columns_dropped" >&2
  exit 1
fi

runtime_reachability="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-reachability.sql")"
if [[ "$runtime_reachability" != "refused/refused/refused/refused/1/0/visible/1" ]]; then
  printf 'Runtime reachability proof failed; expected the three malformed runtime shapes and the connector enrollment with an URL refused, exactly one row behind the link credential, none without it, link_last_seen_at readable by the worker and toolset_epoch bumped by the tenant and read by the worker, got:\n%s\n' "$runtime_reachability" >&2
  exit 1
fi

runtime_read_snapshots="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-read-snapshots.sql")"
if [[ "$runtime_read_snapshots" != "isolated/api-only" ]]; then
  printf 'Runtime read snapshot RLS proof failed; expected tenant isolation and API-only access, got:\n%s\n' "$runtime_read_snapshots" >&2
  exit 1
fi

enrollment_isolation="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-enrollment-isolation.sql")"
if [[ "$enrollment_isolation" != "0/1/0" ]]; then
  printf 'Runtime enrollment isolation proof failed; expected invisible without the secret, visible with it and invisible from another tenant, got:\n%s\n' "$enrollment_isolation" >&2
  exit 1
fi

session_visibility="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/session-visibility.sql")"
if [[ "$session_visibility" != "0/1/0/0" ]]; then
  printf 'Session visibility proof failed; expected zero by tenant alone, one for the owner, zero for another user and zero rows revoked by another user, got:\n%s\n' "$session_visibility" >&2
  exit 1
fi

push_subscriptions="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/push-subscriptions.sql")"
if [[ "$push_subscriptions" != "1/0/0" ]]; then
  printf 'Push subscriptions proof failed; expected own=1, other tenant=0, cascade purge=0, got:\n%s\n' "$push_subscriptions" >&2
  exit 1
fi

connector_release_seen="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/connector-release-seen.sql")"
if [[ "$connector_release_seen" != "1/0/0" ]]; then
  printf 'Connector release seen proof failed; expected own=1, other member=0, other tenant=0, got:\n%s\n' "$connector_release_seen" >&2
  exit 1
fi

provider_incidents="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/provider-incidents.sql")"
if [[ "$provider_incidents" != "1/0/1/0/0" ]]; then
  printf 'Provider incidents RLS proof failed; expected own=1, other=0, worker under tenant A=1, worker without tenant=0, cascade=0, got:\n%s\n' "$provider_incidents" >&2
  exit 1
fi

routine_executions="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/routine-executions.sql")"
if [[ "$routine_executions" != "1/0/0" ]]; then
  printf 'Routine executions proof failed; expected own=1, other tenant=0, cascade=0, got:\n%s\n' "$routine_executions" >&2
  exit 1
fi

routine_group="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/routine-group.sql")"
if [[ "$routine_group" != "refused/refused/1/0" ]]; then
  printf 'Routine group xor/RLS proof failed; expected refused/refused/1/0, got:\n%s\n' "$routine_group" >&2
  exit 1
fi

permission_pipeline="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/permission-pipeline.sql" | tail -n 1)"
permission_pipeline_expected="1|refused|workers_not_ready|runs_in_flight|switched:legacy>v2|unchanged|2|refused|awaiting_human|ready|switched:1|pending/pending/awaiting_human/-/-|3|null"
if [[ "$permission_pipeline" != "$permission_pipeline_expected" ]]; then
  printf 'Permission pipeline proof failed; expected %s, got:\n%s\n' "$permission_pipeline_expected" "$permission_pipeline" >&2
  exit 1
fi

# Onboarding par personne (0025) : meme preuve que le mode URL ci-dessus, avec
# le rejeu du fichier de migration livre tel quel.
docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL' >/dev/null
update organizations set onboarded_at = now() where id = '10000000-0000-4000-8000-000000000001';
alter table users drop column onboarding_completed;
delete from schema_migrations where version = '0025_user_onboarding_completed';
SQL
docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/db/migrations/0025_user_onboarding_completed.sql" >/dev/null
user_onboarding="$(docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL'
update organizations set onboarded_at = null where id = '10000000-0000-4000-8000-000000000001';
select (select onboarding_completed from users where id = '30000000-0000-4000-8000-000000000031')::text
  || '/' || (select onboarding_completed from users where id = '30000000-0000-4000-8000-000000000032')::text
  || '/' || (select column_default from information_schema.columns
              where table_name = 'users' and column_name = 'onboarding_completed');
set role ohb_api;
update users set onboarding_completed = false where id = '30000000-0000-4000-8000-000000000031';
select onboarding_completed::text from users where id = '30000000-0000-4000-8000-000000000031';
reset role;
SQL
)"
if [[ "$user_onboarding" != $'true/false/false\nfalse' ]]; then
  printf 'User onboarding flag proof failed; expected backfill true/false with default false, then false after the ohb_api reset, got:\n%s\n' "$user_onboarding" >&2
  exit 1
fi

# Playbooks structurés : même cloisonnement tenant que les bots.
playbooks="$(docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1"' -- "$database" <<'SQL' | tail -n 1
create temp table playbook_proof (own int, other int);
grant insert, update, select on playbook_proof to ohb_api;
insert into playbooks (id, organization_id, key, name) values
  ('50000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000001', 'brief', 'Brief A'),
  ('50000000-0000-4000-8000-000000000062', '20000000-0000-4000-8000-000000000002', 'brief', 'Brief B');
insert into bot_playbooks (organization_id, bot_id, playbook_id) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000061'),
  ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000022', '50000000-0000-4000-8000-000000000062');
set role ohb_api;
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false);
insert into playbook_proof (own, other)
  select (select count(*) from playbooks),
         (select count(*) from playbooks where organization_id = '20000000-0000-4000-8000-000000000002');
reset role;
select own || '/' || other from playbook_proof;
SQL
)"
if [[ "$playbooks" != "1/0" ]]; then
  printf 'Playbook RLS proof failed; expected 1/0 (own visible, other hidden), got:\n%s\n' "$playbooks" >&2
  exit 1
fi

api_instances="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/api-instances.sql")"
if [[ "$api_instances" != "off/1/1/denied" ]]; then
  printf 'API instances proof failed; expected no RLS, API write, worker read, worker insert denied, got:\n%s\n' "$api_instances" >&2
  exit 1
fi

# La porte du produit (0068), meme preuve que la passe psql locale.
waitlist_access="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/waitlist-access.sql" | tail -n 1)"
if [[ "$waitlist_access" != "granted|alpha|none|refused|refused|refused|none|3/refused|none|refused|refused|refused" ]]; then
  printf 'Waitlist access proof failed; expected API grant, gate open for the approved address only, solidary columns, revocation, a bounded account tier and a rejection the gate ignores and the approval cannot overwrite, got:\n%s\n' "$waitlist_access" >&2
  exit 1
fi

# Pagination keyset, echappement du like, bornes et garde 42501 des fonctions de
# 0059. Placée ici : la preuve insere une organisation et 254 comptes, elle ne
# doit précéder aucun comptage global, et la preuve de memoire qui suit supprime
# le tenant A.
staff_user_paging="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/staff-user-paging.sql")"
if [[ "$staff_user_paging" != "2|2|0|4|4|2|p-gamma@paging.test|p_beta@paging.test|0|p-alpha@paging.test|200|1|true/true|thread/Alpha/Paging Org|0|denied|denied|denied|denied" ]]; then
  printf 'Staff user paging proof failed; expected two disjoint keyset pages, escaped like, capped bounds, a thread resolved without its title and 42501 without a live staff GUC, got:\n%s\n' "$staff_user_paging" >&2
  exit 1
fi

# Cadrage et garde de staff_audit_scope (0060) : un tenant demandé ne rend que
# lui, un sujet traverse les tenants, un appel sans cadre est refusé. Ses
# identifiants d'audit sont détachés, elle ne dépend d'aucune autre preuve.
staff_audit_scope="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/staff-audit-scope.sql")"
if [[ "$staff_audit_scope" != "2|0|2|1|3|42501|42501|22023" ]]; then
  printf 'Staff audit scope proof failed; expected the asked tenant only, a subject across tenants, the actor branch, 42501 without a live staff GUC and 22023 without a scope, got:\n%s\n' "$staff_audit_scope" >&2
  exit 1
fi

# Destinataires de l'avis de fermeture (0149), meme preuve que la passe psql.
closure_notice="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/closure-notice-recipients.sql")"
if [[ "$closure_notice" != "true/true/true/1|1/true|account_closure_notice|denied|denied" ]]; then
  printf 'Closure notice recipients proof failed; expected every account once with the table total, a bound that cuts rows but never the total, the new outbox kind and 42501 without a live staff GUC, got:\n%s\n' "$closure_notice" >&2
  exit 1
fi

# Le geste du support (0071), meme preuve que la passe psql locale : elle insere
# ses propres espaces et comptes, donc elle vient en DERNIER.
staff_password_reset="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/staff-password-reset.sql" | tail -n 1)"
if [[ "$staff_password_reset" != "reset|replaced|raised|2|password_change|1|google_only|none|no_organization|kept|0|42501|22023" ]]; then
  printf 'Staff password reset proof failed; expected a full reset with its sessions closed, an untouched neighbour, both refusals writing nothing, 42501 without a live staff GUC and 22023 on a short hash, got:\n%s\n' "$staff_password_reset" >&2
  exit 1
fi

# Les policies ohb_worker en using (true), meme preuve que la passe psql locale.
worker_policy_exceptions="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/worker-policy-exceptions.sql")"
if [[ "$worker_policy_exceptions" != "$worker_policy_exceptions_expected" ]]; then
  printf 'Worker policy exceptions proof failed; expected the frozen using (true) list and every revoked table, got:\n%s\nexpected:\n%s\n' "$worker_policy_exceptions" "$worker_policy_exceptions_expected" >&2
  exit 1
fi

# 0154 : audit_chain_for_purge(org), meme preuve que la passe psql locale.
purge_fn="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/audit-chain-for-purge.sql" | tail -n 1)"
if [[ "$purge_fn" != "$purge_fn_expected" ]]; then
  printf 'audit_chain_for_purge proof failed; got:\n%s\nexpected:\n%s\n' "$purge_fn" "$purge_fn_expected" >&2
  exit 1
fi

# Un run termine ne change plus de statut (0081), meme preuve que la passe psql locale.
runs_final_status="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runs-final-status.sql" | tail -n 1)"
if [[ "$runs_final_status" != "denied/denied/queued/final/completed" ]]; then
  printf 'Runs final status proof failed; expected completed and failed runs to keep their status, a cancelled run to requeue, other columns writable and running to complete, got:\n%s\n' "$runs_final_status" >&2
  exit 1
fi

# Identite et fencing de run_events (0092), meme preuve que la passe psql locale.
run_events_identity="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/run-events-identity.sql" | tail -n 1)"
if [[ "$run_events_identity" != "$run_events_identity_expected" ]]; then
  printf 'Run events identity proof failed; expected identity stamped from the run, a stale lease refused, a replay absorbed and tenant isolation, got:\n%s\nexpected:\n%s\n' "$run_events_identity" "$run_events_identity_expected" >&2
  exit 1
fi

# La derniere connexion (0075), meme preuve que la passe psql locale : elle
# insere son propre espace et ses comptes, donc elle vient apres tout comptage
# global.
last_login="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/last-login.sql" | tail -n 1)"
if [[ "$last_login" != "null|written|null|2026-05-04 08:09:10|null|match|null" ]]; then
  printf 'Last login proof failed; expected no backfill, an API write, nothing derived from session activity, and the column served by staff_search_users and staff_get_user, got:\n%s\n' "$last_login" >&2
  exit 1
fi


printf 'PostgreSQL migration and tenant RLS proof passed.\n'
provision_rls="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/bot-profile-provisions.sql" | tail -n 1)"
if [[ "$provision_rls" != "isolated/forced" ]]; then
  printf 'Bot profile provision RLS proof failed: %s\n' "$provision_rls" >&2
  exit 1
fi
model_proof_rls="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/runtime-model-selection-proofs.sql" | tail -n 1)"
if [[ "$model_proof_rls" != "isolated/forced" ]]; then
  printf 'Runtime model selection proof RLS failed: %s\n' "$model_proof_rls" >&2
  exit 1
fi
cleanup_rls="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/bot-host-cleanups.sql" | tail -n 1)"
if [[ "$cleanup_rls" != "isolated/forced" ]]; then
  printf 'Bot host cleanup RLS proof failed: %s\n' "$cleanup_rls" >&2
  exit 1
fi
creation_requests="$(docker exec -i "$container" sh -ceu \
  'psql -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$1"' -- "$database" \
  < "$root/tests/integration/bot-creation-requests.sql" | tail -n 1)"
if [[ "$creation_requests" != "scoped/forced" ]]; then
  printf 'Bot creation request proof failed: %s\n' "$creation_requests" >&2
  exit 1
fi
