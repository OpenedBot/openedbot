-- Un accusé jamais déposé ne se voyait nulle part : cette table garde chaque
-- décision de dépôt et chaque transition du worker pour rendre ces silences
-- observables. Elle ne portera jamais d'adresse e-mail, ni en clair, ni dans
-- une clé, ni dans `detail`.
--
-- La table est hors tenant et sans RLS, comme `email_outbox` et
-- `waitlist_signups`. `ohb_api` écrit les décisions de dépôt et peut les lire
-- pour le futur backoffice. `ohb_worker` écrit les transitions de livraison,
-- sans aucune raison de relire le journal.
begin;

create table if not exists email_outbox_events (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid,
  kind text not null,
  event text not null check (event in ('queued','duplicate_skipped','sent','retry','failed','lease_lost')),
  attempt integer,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  check (jsonb_typeof(detail) = 'object')
);

create index if not exists email_outbox_events_recent_idx
  on email_outbox_events (occurred_at desc);

grant insert, select on email_outbox_events to ohb_api;
grant insert on email_outbox_events to ohb_worker;

insert into schema_migrations(version) values ('0067_email_outbox_events')
on conflict (version) do nothing;

commit;
