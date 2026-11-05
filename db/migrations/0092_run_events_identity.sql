-- Identité stable de chaque événement : bot, tour, session
-- Hermes et génération de bail, portés par la ligne `run_events` elle-même.
--
-- Pourquoi un trigger et pas une colonne de plus dans chaque INSERT : une
-- dizaine d'écrivains (worker, file, annulation, routes API) insèrent dans
-- `run_events`. L'identité se DÉDUIT du run au moment de l'écriture, en un
-- seul endroit : aucun écrivain ne peut la diverger, l'oublier ou la mentir.
--
-- - `bot_id`      : `runs.bot_id` à l'écriture. Instantané : la purge d'un bot
--                   n'efface pas qui a parlé dans un fil conservé.
-- - `turn_id`     : le tour utilisateur, `coalesce(workflows.root_run_id,
--                   runs.id)`. Toutes les étapes d'un workflow partagent le
--                   tour de leur run racine ; un run hors workflow est son
--                   propre tour (même valeur que `message_ingress.run_id` d'un
--                   DM, avec ou sans workflow).
-- - `session_key` : `coalesce(runs.execution_session_key,
--                   threads.hermes_session_id)`, la clé que le worker envoie à
--                   Hermes. Identifiant structurel `openedbot:{org}:…`, pas un secret.
-- - `lease_generation` : le bail sous lequel la ligne est écrite.
--
-- Fencing : un écrivain qui FOURNIT `lease_generation` déclare écrire sous ce
-- bail. S'il diffère de `runs.lease_generation`, l'INSERT échoue (23514,
-- contrainte `run_events_lease_fence`) : un événement tardif d'un worker dont
-- le run a été repris ne peut plus atterrir dans le fil. La ligne `runs` est
-- verrouillée `for share` dans ce cas, donc une reprise concurrente attend le
-- commit au lieu de passer entre la lecture et l'écriture. Un écrivain qui ne
-- fournit rien (API, file, notices) n'est pas un porteur de bail : la ligne
-- reçoit la génération courante, sans verrou.
--
-- Reprise des lignes existantes : `bot_id`, `turn_id` et `session_key` se
-- déduisent du run et sont remplis ici. `lease_generation` reste NULL : la
-- génération qui a écrit une ligne passée n'est connue nulle part, et la
-- génération actuelle du run serait une affirmation fausse.
--
-- Pas d'index : toutes les lectures restent par `(organization_id, cursor)`
-- ou `(organization_id, run_id, sequence)`. Le filtrage par tour est l'affaire
-- du client sur le flux de l'organisation.
--
-- RLS : rien à ajouter. Les colonnes héritent des policies de la table
-- (tenant `openedbot_api`, `openedbot_worker` using true) ; le trigger s'exécute avec les
-- droits de l'écrivain (security invoker) et ne lit que `runs`, `workflows` et
-- `threads` de la même organisation.
begin;

alter table run_events
  add column bot_id uuid,
  add column turn_id uuid,
  add column session_key text,
  add column lease_generation bigint;

alter table run_events
  add constraint run_events_lease_generation_nonnegative
    check (lease_generation is null or lease_generation >= 0);

update run_events event
   set bot_id = run.bot_id,
       turn_id = coalesce(workflow.root_run_id, run.id),
       session_key = coalesce(run.execution_session_key, thread.hermes_session_id)
  from runs run
  left join workflows workflow
    on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
  left join threads thread
    on thread.organization_id = run.organization_id and thread.id = run.thread_id
 where run.organization_id = event.organization_id and run.id = event.run_id;

create or replace function run_events_stamp_identity() returns trigger
language plpgsql
as $$
declare
  current_run record;
begin
  if new.lease_generation is null then
    select run.bot_id, run.lease_generation,
           coalesce(workflow.root_run_id, run.id) as turn_id,
           coalesce(run.execution_session_key, thread.hermes_session_id) as session_key
      into current_run
      from runs run
      left join workflows workflow
        on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
      left join threads thread
        on thread.organization_id = run.organization_id and thread.id = run.thread_id
     where run.organization_id = new.organization_id and run.id = new.run_id;
  else
    select run.bot_id, run.lease_generation,
           coalesce(workflow.root_run_id, run.id) as turn_id,
           coalesce(run.execution_session_key, thread.hermes_session_id) as session_key
      into current_run
      from runs run
      left join workflows workflow
        on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
      left join threads thread
        on thread.organization_id = run.organization_id and thread.id = run.thread_id
     where run.organization_id = new.organization_id and run.id = new.run_id
       for share of run;
  end if;
  -- Run introuvable : la FK run_events -> runs refuse la ligne juste après.
  if not found then
    return new;
  end if;
  if new.lease_generation is not null and new.lease_generation <> current_run.lease_generation then
    raise exception 'run % event written under lease generation %, current is %',
      new.run_id, new.lease_generation, current_run.lease_generation
      using errcode = '23514', constraint = 'run_events_lease_fence';
  end if;
  new.bot_id := current_run.bot_id;
  new.turn_id := current_run.turn_id;
  new.session_key := current_run.session_key;
  new.lease_generation := current_run.lease_generation;
  return new;
end;
$$;

drop trigger if exists run_events_stamp_identity on run_events;
create trigger run_events_stamp_identity
  before insert on run_events
  for each row execute function run_events_stamp_identity();

insert into schema_migrations(version) values ('0092_run_events_identity') on conflict (version) do nothing;

commit;
