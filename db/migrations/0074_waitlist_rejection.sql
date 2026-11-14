-- Refuser une inscription, et s'en souvenir.
--
-- Le backoffice savait valider, changer le mode, retirer l'accès et RETIRER la
-- ligne. Il ne savait pas dire non. Ce manque a coûté le 2026-09-12 : une
-- campagne de sondes automatisées (`massassign1`, `cookie-probe`, `probe1` à
-- `probe4`, `kimi.pentest.probe`, toutes sur un domaine parfaitement livrable)
-- s'est posée dans la file, et les seuls gestes disponibles étaient mauvais :
--
--   * `delete` EFFACE la ligne, donc l'adresse se réinscrit depuis la page
--     publique la seconde d'après, reçoit un nouvel accusé, et revient. La
--     suppression n'est pas une décision, c'est un oubli ;
--   * ne rien faire laisse la ligne « en attente », indiscernable d'une
--     personne que personne n'a encore regardée. Le membre suivant de l'équipe
--     la réexamine, et ainsi de suite.
--
-- Le refus garde la ligne, et c'est LÀ qu'est son effet : `email` est unique,
-- donc la route publique répond `already` sans rien écrire et sans accusé. Une
-- adresse refusée ne peut plus se remettre elle-même dans la file.
--
--   `rejected_at`   l'instant du refus. C'est lui qui porte la décision.
--   `rejected_by_staff_user_id`  son auteur. `on delete set null` comme celui
--                   de la validation : un départ de l'équipe ne doit pas
--                   rouvrir une porte fermée.
--   `rejection_reason`  une note INTERNE, bornée, facultative. Elle n'est
--                   jamais envoyée : un refus ne s'annonce pas, surtout pas à
--                   une sonde à qui cela apprendrait que quelqu'un regarde.
--
-- Les deux décisions s'excluent. C'est cette contrainte, et pas une condition
-- ajoutée au passage dans `auth.ts`, qui garantit qu'une adresse refusée
-- n'entre pas : la porte lit `approved_at is not null`, et la base interdit
-- qu'une ligne refusée porte une validation. Les routes staff exigent en plus
-- de lever le refus avant de valider, et de retirer l'accès avant de refuser :
-- chaque transition reste un geste nommé, jamais un effet de bord.
--
-- Aucun `grant` nouveau : `openedbot_api` a `select`, `insert`, `update` et `delete`
-- sur cette table depuis 0065 et 0066. La table reste hors tenant et sans RLS,
-- pour la raison de 0063 : il n'existe pas encore d'organisation à ce moment.
begin;

alter table waitlist_signups
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by_staff_user_id uuid references staff_users(id) on delete set null,
  add column if not exists rejection_reason text;

-- Valider et refuser sont deux verdicts opposés : aucune ligne ne porte les
-- deux. Une validation sur une ligne refusée passerait la porte sans que
-- personne n'ait levé le refus.
alter table waitlist_signups
  drop constraint if exists waitlist_signups_decision_exclusive_check;
alter table waitlist_signups
  add constraint waitlist_signups_decision_exclusive_check
  check (approved_at is null or rejected_at is null);

-- Une note sans refus serait un commentaire orphelin que rien n'afficherait ;
-- la borne tient la colonne à la taille d'une note, pas d'un dossier.
alter table waitlist_signups
  drop constraint if exists waitlist_signups_rejection_reason_check;
alter table waitlist_signups
  add constraint waitlist_signups_rejection_reason_check
  check (rejection_reason is null or (rejected_at is not null and length(rejection_reason) <= 280));

-- Le filtre par DÉFAUT du backoffice : tout sauf les refusées. C'est la requête
-- la plus jouée de cet écran, et le prédicat est volontairement le plus large
-- des deux : « ni validée ni refusée » implique « non refusée », donc la file
-- des seules inscriptions en attente se sert du même index, alors que
-- l'inverse serait faux.
create index if not exists waitlist_signups_not_rejected_idx
  on waitlist_signups (created_at desc, id desc)
  where rejected_at is null;

insert into schema_migrations(version) values ('0074_waitlist_rejection')
on conflict (version) do nothing;

commit;
