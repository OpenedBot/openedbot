begin;

-- OHB-70 : journaliser l'inscription de la première clé device après le PoP.
--
-- La contrainte est remplacée pour accepter le nouvel événement sans modifier
-- la table ni les kinds déjà admis par la migration 0053.

alter table runtime_link_events drop constraint runtime_link_events_kind_check;
alter table runtime_link_events add constraint runtime_link_events_kind_check
  check (kind in (
    'connected', 'replaced', 'disconnected', 'revoked', 'rotated', 'hijack_suspected',
    'pop_failed', 'pop_missing', 'unattributed_session', 'clock_skew',
    'worm_write_failed', 'anchor_tampered', 'device_key_registered'
  ));

comment on constraint runtime_link_events_kind_check on runtime_link_events is
  'pop_failed : preuve de possession refusée (4401). pop_missing : runtime sans clé device lié hors production. unattributed_session : session Hermes inconnue d''OHB relevée par la réconciliation. clock_skew : horloge du connecteur en désaccord avec les dispatches de l''API. worm_write_failed : une ancre ou un verdict n''a pas pu être déposé dans le bucket WORM (meta.reason = anchor | verdict). anchor_tampered : l''ancre archivée hors base ne décrit pas l''export vérifié ni l''ancre en base — la base ou l''export a été réécrit. device_key_registered : première clé device inscrite après preuve de possession sous le jeton courant (runtime enrôlé avant le PoP).';

insert into schema_migrations(version) values ('0054_runtime_link_device_key_registered');
commit;
