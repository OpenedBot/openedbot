begin;

-- Robustesse du lien connecteur.
--
-- 1. Rotation automatique dont la livraison est incertaine.
--
-- Le worker pousse `link.rotate` par la route de contrôle interne. Quand la
-- réponse se perd ou expire, l'hôte a peut-être déjà enregistré le nouveau
-- jeton : défaire la rotation le couperait, la garder avec dix minutes de
-- grâce couperait l'hôte qui ne l'a pas reçu. Les deux hashes restent donc
-- valables, et cette colonne marque la transition non confirmée. La
-- prochaine admission de l'hôte tranche : le nouveau jeton confirme la
-- rotation (l'ancien hash part), l'ancien la défait (il redevient courant).
--
-- NULL hors de cette attente. Les droits SELECT/UPDATE sur runtimes et leurs
-- politiques RLS couvrent déjà la colonne.
alter table runtimes
  add column if not exists link_token_rotation_unconfirmed_at timestamptz null;

comment on column runtimes.link_token_rotation_unconfirmed_at is
  'Automatic link token rotation whose link.rotate delivery is unknown: both hashes stay valid until the host is admitted again (new token confirms, previous token reverts). NULL otherwise.';

-- 2. Réconciliation des sessions : la passe horaire lit au plus cent
-- runtimes. Triée par identifiant, elle relisait toujours les cent mêmes et
-- les suivants n'étaient jamais réconciliés. Elle prend désormais ceux dont
-- la dernière lecture est la plus ancienne (jamais lus d'abord), et date
-- chaque tentative, réussie ou non.
alter table runtimes
  add column if not exists link_sessions_reconciled_at timestamptz null;

comment on column runtimes.link_sessions_reconciled_at is
  'Last session reconciliation attempt for this connector runtime (worker link-security pass). NULL before the first one; the pass reads the oldest first.';

insert into schema_migrations(version) values ('0174_runtime_link_robustness') on conflict (version) do nothing;
commit;
