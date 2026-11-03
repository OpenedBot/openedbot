begin;

-- Catch-up borné des routines : le tick ne tire toujours qu'UNE occurrence au
-- réveil (un worker éteint 6 h ne rattrape pas six tirs horaires). Les
-- occurrences sautées entre `next_run_at` échu et maintenant sont comptées
-- (plafond applicatif 24) pour que l'opérateur voie le trou.
--
-- `busy_retries` borne le report +60 s d'un fil occupé : passé 10 reports
-- consécutifs, le worker abandonne l'occurrence, avance l'horloge, et remet
-- le compteur à zéro. Sans ce plafond une conversation longue reportait
-- la routine indéfiniment.
alter table routines
  add column missed_count integer not null default 0,
  add column last_missed_at timestamptz,
  add column busy_retries integer not null default 0,
  add constraint routines_missed_count_nonneg check (missed_count >= 0),
  add constraint routines_busy_retries_nonneg check (busy_retries >= 0);

comment on column routines.missed_count is
  'Occurrences planifiées sautées (catch-up borné + reports de fil occupé épuisés). Compteur cumulatif, plafond de comptage côté worker.';
comment on column routines.last_missed_at is
  'Dernier instant où missed_count a été incrémenté.';
comment on column routines.busy_retries is
  'Reports consécutifs +60 s tant que le fil DM du bot est occupé. Remis à zéro après un tir ou un saut d''occurrence.';

insert into schema_migrations(version) values ('0038_routine_missed')
on conflict (version) do nothing;

commit;
