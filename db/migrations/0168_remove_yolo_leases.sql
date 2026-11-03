-- Retrait du mode YOLO à baux signés (0165 à 0167, appliqués en production le
-- 2026-11-03 sans qu'aucun bail ait pu être émis : pas de clé de signature).
-- Le mode YOLO sera repris comme un mode de permission du bot. Cette migration
-- retire tout ce que la série avait créé et rend aux deux contraintes qu'elle
-- avait élargies leur définition d'avant (0144 et 0149). Sur une base qui n'a
-- jamais joué 0165 à 0167, elle ne fait rien d'autre que réécrire ces deux
-- contraintes à l'identique.
--
-- Une ligne qui porte encore une valeur YOLO (étape `yolo`, e-mail `yolo_*`)
-- fait échouer la contrainte et donc la migration, qui s'arrête avant le
-- déploiement : rien n'est effacé en silence.
begin;

drop function if exists grant_permission_yolo_lease cascade;
drop function if exists grant_permission_yolo_solo_lease cascade;
drop function if exists revoke_permission_yolo_leases cascade;
drop function if exists revoke_permission_yolo_leases_by_host cascade;
drop function if exists end_permission_yolo_solo_default cascade;
drop function if exists permission_yolo_is_solo cascade;

drop table if exists permission_yolo_audit_quarantine;
drop table if exists permission_yolo_audit;
drop table if exists permission_yolo_consents;
drop table if exists permission_yolo_leases;

drop function if exists permission_yolo_audit_quarantine_append_only cascade;
drop function if exists permission_yolo_audit_append_only cascade;
drop function if exists permission_yolo_leases_guard cascade;

alter table approval_requests drop constraint if exists approval_requests_decision_stage_check;
alter table approval_requests
  add constraint approval_requests_decision_stage_check
    check (decision_stage is null or decision_stage in
      ('forbidden', 'floor', 'opaque', 'deletion', 'tool_policy', 'grant', 'review', 'full', 'human', 'unattended'));

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check check (kind in (
  'agency_client_invitation',
  'agency_client_response',
  'organization_member_invitation',
  'waitlist_confirmation',
  'waitlist_access_granted',
  'waitlist_access_tier_changed',
  'waitlist_access_revoked',
  'staff_account_created',
  'staff_password_reset',
  'staff_login_code',
  'email_login_code',
  'provider_quota_reached',
  'account_purge_completed',
  'account_closure_notice',
  'support_new_conversation',
  'runtime_link_down',
  'runtime_link_restored',
  'runtime_connector_outdated'
));

insert into schema_migrations(version) values ('0168_remove_yolo_leases')
on conflict (version) do nothing;

commit;
