-- La liste d'attente de la page publique `/` : une adresse, la langue de la
-- page au moment de l'inscription, rien d'autre. Hors tenant : il n'y a pas
-- encore d'organisation, et la table n'est lue par aucune route publique.
begin;
create table if not exists waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  locale text,
  created_at timestamptz not null default now()
);
insert into schema_migrations(version) values ('0063_waitlist_signups')
on conflict (version) do nothing;
commit;
