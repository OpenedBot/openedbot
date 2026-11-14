begin;

-- Socle multi-tenant : identités, organisations, appartenances, sessions et
-- portes d'entrée (invitations, OAuth). Chaque table applicative porte une
-- clé composite (organization_id, id) reprise par toutes les FK aval : le
-- cloisonnement tenant est structurel, pas seulement une policy.

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  email text not null,
  password_hash text,
  google_subject text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (google_subject)
);
create unique index users_email_unique_idx on users (lower(email));

create table organizations (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  onboarding jsonb,
  onboarded_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table sessions (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('web', 'native')),
  session_token_hash text unique,
  access_token_hash text unique,
  refresh_token_hash text unique,
  csrf_hash text,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references memberships(organization_id, user_id) on delete cascade
);

create table native_auth_codes (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  code_hash text not null unique,
  code_challenge text not null,
  redirect_uri text not null,
  client_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references memberships(organization_id, user_id) on delete cascade
);

-- `invited_by` référence l'appartenance, pas seulement l'utilisateur : un
-- inviteur qui quitte l'organisation ne peut pas laisser une invitation
-- orpheline rattachée à un tenant où il n'est plus rien.
create table organization_invitations (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'member')),
  token_hash text not null unique,
  invited_by uuid not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint organization_invitations_invited_by_membership_fkey
    foreign key (organization_id, invited_by)
    references memberships (organization_id, user_id)
);

create table operator_profiles (
  organization_id uuid primary key references organizations(id) on delete cascade,
  username text not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, username)
);

-- Tentatives OAuth persistées : le payload est chiffré, et l'API ne peut
-- ouvrir une ligne qu'en présentant le hash de l'identifiant ou du state.
create table oauth_attempts (
  attempt_hash text primary key,
  state_hash text not null unique,
  payload_ciphertext text not null,
  payload_nonce text not null,
  payload_tag text not null,
  payload_key_id text not null,
  return_to text,
  status text not null default 'pending'
    check (status in ('pending', 'exchanging', 'done_web', 'done_native', 'failed')),
  failure_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (failure_code is null or status = 'failed')
);

create index oauth_attempts_expiry_idx on oauth_attempts (expires_at);

alter table organizations enable row level security;
alter table organizations force row level security;
alter table memberships enable row level security;
alter table memberships force row level security;
alter table sessions enable row level security;
alter table sessions force row level security;
alter table native_auth_codes enable row level security;
alter table native_auth_codes force row level security;
alter table organization_invitations enable row level security;
alter table organization_invitations force row level security;
alter table operator_profiles enable row level security;
alter table operator_profiles force row level security;
alter table oauth_attempts enable row level security;
alter table oauth_attempts force row level security;

create policy organizations_tenant on organizations to openedbot_api
  using (id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy memberships_tenant on memberships to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  )
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy sessions_credential on sessions to openedbot_api
  using (
    session_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or access_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or refresh_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or session_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or access_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or refresh_token_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );
create policy native_auth_codes_credential on native_auth_codes to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or code_hash = nullif(current_setting('app.session_credential_hash', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or code_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

create policy operator_profiles_tenant on operator_profiles to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- Le SSO Google arrive avec un e-mail vérifié et RIEN d'autre : ni organisation
-- ni jeton d'invitation. `app.invited_email` est la porte de lecture qui permet
-- de retrouver l'invitation qui vise cette adresse : lecture seulement, le
-- `with check` ne s'élargit pas.
create policy organization_invitations_tenant on organization_invitations to openedbot_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.session_credential_hash', true), '')
    or lower(email) = nullif(current_setting('app.invited_email', true), '')
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.session_credential_hash', true), '')
  );

create policy organizations_worker on organizations to openedbot_worker using (true) with check (true);
create policy memberships_worker on memberships to openedbot_worker using (true) with check (true);
create policy sessions_worker on sessions to openedbot_worker using (true) with check (true);
create policy native_auth_codes_worker on native_auth_codes to openedbot_worker using (true) with check (true);
create policy organization_invitations_worker on organization_invitations to openedbot_worker using (true) with check (true);
create policy operator_profiles_worker on operator_profiles to openedbot_worker using (true) with check (true);

-- Les routes publiques ne reçoivent que l'identifiant ou le state aléatoire.
-- L'API les hache avant d'ouvrir cette porte et ne peut donc jamais énumérer
-- les tentatives actives avec son rôle applicatif.
create policy oauth_attempts_select_lookup on oauth_attempts
  for select to openedbot_api
  using (
    attempt_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
    or state_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
  );
create policy oauth_attempts_insert_lookup on oauth_attempts
  for insert to openedbot_api
  with check (
    attempt_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
    or state_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
  );
create policy oauth_attempts_update_lookup on oauth_attempts
  for update to openedbot_api
  using (
    attempt_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
    or state_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
  )
  with check (
    attempt_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
    or state_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
  );
create policy oauth_attempts_delete_lookup on oauth_attempts
  for delete to openedbot_api
  using (
    attempt_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
    or state_hash = nullif(current_setting('app.oauth_lookup_hash', true), '')
  );

grant select, insert, update, delete on users to openedbot_api;
grant select, insert, update, delete on organizations, memberships, sessions, native_auth_codes,
  organization_invitations, operator_profiles to openedbot_api;
grant select, insert, update, delete on organizations, memberships, sessions, native_auth_codes,
  organization_invitations, operator_profiles to openedbot_worker;
grant select, insert, update, delete on oauth_attempts to openedbot_api;

-- Nettoyage borné sans ouvrir une policy permettant au rôle applicatif de
-- parcourir toutes les tentatives. La fonction ne rend aucun contenu.
create function purge_expired_oauth_attempts() returns bigint
language sql
security definer
set search_path = pg_catalog, public
as $$
  with deleted as (
    delete from public.oauth_attempts where expires_at <= now() returning 1
  )
  select count(*)::bigint from deleted;
$$;
revoke all on function purge_expired_oauth_attempts() from public;
grant execute on function purge_expired_oauth_attempts() to openedbot_api;

insert into schema_migrations(version) values ('0001_tenancy_auth')
on conflict (version) do nothing;

commit;
