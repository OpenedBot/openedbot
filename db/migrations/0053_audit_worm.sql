begin;

-- Ancrage WORM externe des ancres et des verdicts.
--
-- Additive. La base garde son rôle (dernière ancre par runtime, verdicts) ;
-- chaque ancre enregistrée et chaque verdict rendu sont AUSSI déposés une fois
-- dans un bucket R2 dédié sous verrou de rétention. Ici : les deux kinds du
-- journal du lien qui en rendent compte, et l'état WORM porté par chaque
-- verdict.

alter table runtime_link_events drop constraint runtime_link_events_kind_check;
alter table runtime_link_events add constraint runtime_link_events_kind_check
  check (kind in (
    'connected', 'replaced', 'disconnected', 'revoked', 'rotated', 'hijack_suspected',
    'pop_failed', 'pop_missing', 'unattributed_session', 'clock_skew',
    'worm_write_failed', 'anchor_tampered'
  ));

comment on constraint runtime_link_events_kind_check on runtime_link_events is
  'pop_failed : preuve de possession refusée (4401). pop_missing : runtime sans clé device lié hors production. unattributed_session : session Hermes inconnue d''openedbot relevée par la réconciliation. clock_skew : horloge du connecteur en désaccord avec les dispatches de l''API. worm_write_failed : une ancre ou un verdict n''a pas pu être déposé dans le bucket WORM (meta.reason = anchor | verdict). anchor_tampered : l''ancre archivée hors base ne décrit pas l''export vérifié ni l''ancre en base — la base ou l''export a été réécrit.';

alter table runtime_audit_verifications
  add column worm_state text not null default 'disabled'
    constraint runtime_audit_verifications_worm_state_check check (worm_state in ('disabled', 'missing', 'matches', 'tampered'));

comment on column runtime_audit_verifications.worm_state is
  'Ce que le bucket WORM disait de l''export au moment du verdict : disabled (aucun store configuré), missing (aucune ancre archivée pour cette position), matches (l''ancre archivée décrit la même position que l''export et que la base), tampered (elle en décrit une autre ; le verdict est alors invalid, code AUDIT_ANCHOR_TAMPERED).';

insert into schema_migrations(version) values ('0053_audit_worm') on conflict (version) do nothing;
commit;
