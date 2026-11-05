begin;

-- Dernière identité déclarée par une session admise du connecteur.
-- Les lignes historiques restent NULL. Les grants SELECT/UPDATE sur runtimes
-- et INSERT sur runtime_link_events existent déjà pour openedbot_api ; leurs
-- politiques RLS tenant/credential restent inchangées.
alter table runtimes
  add column link_agent text null,
  add column link_agent_seen_at timestamptz null;

comment on column runtimes.link_agent is
  'Agent déclaré dans hello par le dernier lien admis, tronqué à 256 caractères. Informatif : une version obsolète ne refuse jamais la session.';
comment on column runtimes.link_agent_seen_at is
  'Date de réception de la dernière déclaration d''agent admise, conservée après déconnexion. NULL avant la première déclaration.';

alter table runtime_link_events drop constraint runtime_link_events_kind_check;
alter table runtime_link_events add constraint runtime_link_events_kind_check
  check (kind in (
    'connected', 'replaced', 'disconnected', 'revoked', 'rotated', 'hijack_suspected',
    'pop_failed', 'pop_missing', 'unattributed_session', 'clock_skew',
    'worm_write_failed', 'anchor_tampered', 'device_key_registered', 'agent_outdated'
  ));

comment on constraint runtime_link_events_kind_check on runtime_link_events is
  'pop_failed : preuve de possession refusée (4401). pop_missing : runtime sans clé device lié hors production. unattributed_session : session Hermes inconnue d''openedbot relevée par la réconciliation. clock_skew : horloge du connecteur en désaccord avec les dispatches de l''API. worm_write_failed : une ancre ou un verdict n''a pas pu être déposé dans le bucket WORM (meta.reason = anchor | verdict). anchor_tampered : l''ancre archivée hors base ne décrit pas l''export vérifié ni l''ancre en base — la base ou l''export a été réécrit. device_key_registered : première clé device inscrite après preuve de possession sous le jeton courant (runtime enrôlé avant le PoP). agent_outdated : version stable du connecteur inférieure au minimum configuré (meta.minimum), sans refus de session.';

insert into schema_migrations(version) values ('0055_runtime_link_agent') on conflict (version) do nothing;
commit;
