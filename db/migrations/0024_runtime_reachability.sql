begin;

-- Comment openedbot atteint un runtime Hermes.
--
-- Jusqu'ici une ligne `runtimes` portait toujours une URL publique et un
-- bearer chiffré : le mode `direct`. Le connecteur (docs/CONNECTOR.md côté
-- hermes-setup) inverse le sens : c'est l'hôte du client qui ouvre UNE
-- connexion sortante vers openedbot, et les requêtes gateway transitent
-- par ce tuyau. Aucun port entrant, aucun domaine, aucun certificat côté
-- client ; le bearer du gateway ne quitte jamais l'hôte.
--
-- Invariant central : openedbot ne compose AUCUNE URL vers un hôte joint
-- par le connecteur. Une ligne `connector` a donc `endpoint` NULL par
-- contrainte, et jamais de bearer : `token_*` sont NULL. Réciproquement une
-- ligne `direct` garde ses quatre colonnes obligatoires et ne porte aucun
-- jeton de lien. La forme est tenue par la base, pas par la route qui écrit.
alter table runtimes
  add column reachability text not null default 'direct'
    constraint runtimes_reachability_check check (reachability in ('direct', 'connector')),
  -- Jamais le jeton de lien : seulement son SHA-256, comme les sessions et
  -- les enrôlements. Unique : un jeton n'ouvre qu'un runtime.
  add column link_token_hash text unique,
  -- L'instance de l'API qui tient actuellement le WebSocket ; sert à fermer
  -- l'ancienne connexion (4001 LINK_REPLACED) quand une plus récente gagne.
  add column link_instance_id text,
  -- Posé à l'ouverture du lien, remis à NULL à sa fermeture.
  add column link_connected_at timestamptz,
  -- Dernier signe de vie (ping applicatif ou requête servie), pour l'état
  -- `disconnected` affiché à l'opérateur.
  add column link_last_seen_at timestamptz;

comment on column runtimes.reachability is
  'direct : URL publique + bearer chiffré ; connector : lien sortant ouvert par l''hôte, endpoint et token NULL par contrainte.';
comment on column runtimes.link_token_hash is
  'SHA-256 du jeton de lien du connecteur, jamais le jeton ; porte RLS runtimes_link_credential.';
comment on column runtimes.link_instance_id is
  'Instance d''API qui tient le WebSocket du lien ; NULL hors connexion.';
comment on column runtimes.link_connected_at is
  'Ouverture de la connexion de lien courante ; NULL quand le lien est fermé.';
comment on column runtimes.link_last_seen_at is
  'Dernier signe de vie du lien connecteur.';

alter table runtimes
  alter column endpoint drop not null,
  alter column token_ciphertext drop not null,
  alter column token_nonce drop not null,
  alter column token_tag drop not null;

-- direct  ⇔ endpoint + token_* renseignés, pas de jeton de lien ;
-- connector ⇔ ni endpoint ni token_*, un jeton de lien.
-- Une ligne connector ne peut donc JAMAIS porter une URL composable.
alter table runtimes add constraint runtimes_reachability_shape_check check (
  (
    reachability = 'direct'
    and endpoint is not null
    and token_ciphertext is not null
    and token_nonce is not null
    and token_tag is not null
    and link_token_hash is null
  ) or (
    reachability = 'connector'
    and endpoint is null
    and token_ciphertext is null
    and token_nonce is null
    and token_tag is null
    and link_token_hash is not null
  )
);

-- Seconde porte, réservée au connecteur qui se reconnecte : il n'a aucune
-- session, seulement son jeton de lien. Même mécanisme que
-- `runtime_enrollments_credential` (0014) : sans le hash exact, aucune ligne
-- n'est visible, pas même son existence. La porte de l'organisation
-- (`runtimes_tenant`) reste inchangée ; les politiques étant permissives,
-- l'une OU l'autre suffit.
create policy runtimes_link_credential on runtimes to openedbot_api
  using (link_token_hash = nullif(current_setting('app.session_credential_hash', true), ''));

-- Un enrôlement peut désormais préparer un runtime connector : il n'a alors
-- pas d'URL à sonder, le lien se prouvera à travers le tuyau.
alter table runtime_enrollments
  add column reachability text not null default 'direct'
    constraint runtime_enrollments_reachability_check check (reachability in ('direct', 'connector'));

alter table runtime_enrollments alter column endpoint drop not null;

alter table runtime_enrollments add constraint runtime_enrollments_reachability_endpoint_check
  check ((reachability = 'direct') = (endpoint is not null));

comment on column runtime_enrollments.reachability is
  'direct : l''enrôlement porte l''URL à sonder ; connector : endpoint NULL, la preuve passe par le lien.';

insert into schema_migrations(version) values ('0024_runtime_reachability')
on conflict (version) do nothing;

commit;
