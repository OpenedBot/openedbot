begin;

-- OHB-20 : Web Push VAPID pour les routines et les approbations.
--
-- L'abonnement vit chez l'utilisateur (un navigateur, un endpoint). La
-- livraison est un fan-out d'organisation : chaque transition eligible
-- (salon, routine, ou DM autonome) produit UNE ligne d'outbox, puis une
-- ligne de livraison par abonnement. La purge du compte (`delete from
-- organizations`) emporte le tout par cascade, comme les autres tables
-- tenant. Aucun DELETE applicatif n'est donc ajoute au worker de
-- suppression : la FK suffit.
--
-- `push_deliveries` plutot qu une colonne `last_notified_sequence` : le
-- fan-out est par abonnement, un nouvel abonnement ne doit pas retrigger
-- l historique, et un 410 sur un navigateur ne doit pas bloquer les
-- autres. La cle (workflow_id, notification_sequence, subscription_id)
-- est l idempotence des retries.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  locale text not null default 'fr',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  failed_at timestamptz,
  unique (endpoint),
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  check (length(endpoint) between 8 and 2048),
  check (endpoint like 'https://%'),
  check (length(p256dh) between 16 and 256),
  check (length(auth) between 8 and 128),
  check (user_agent is null or length(user_agent) between 1 and 512),
  check (locale in ('fr', 'en'))
);

create index push_subscriptions_org_active_idx
  on push_subscriptions (organization_id, created_at desc)
  where failed_at is null;
create index push_subscriptions_user_idx
  on push_subscriptions (organization_id, user_id, created_at desc);

comment on table push_subscriptions is
  'Abonnements Web Push VAPID par utilisateur. L''endpoint est unique au monde : un meme navigateur ne peut pas rester rattache a deux comptes. Cascade a la purge du tenant et au depart d''un membre.';

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;

-- Lecture et ecriture : le membre ne voit que SES abonnements, dans
-- l'organisation courante. `app.user_id` n'est plus pose (retire avec
-- APNs) ; la porte utilisateur est `app.authenticating_user_id`, la
-- meme que les sessions (0019).
create policy push_subscriptions_owner on push_subscriptions to ohb_api
  using (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  )
  with check (
    organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    and user_id = nullif(current_setting('app.authenticating_user_id', true), '')::uuid
  );
create policy push_subscriptions_worker on push_subscriptions to ohb_worker
  using (true) with check (true);

grant select, insert, update, delete on push_subscriptions to ohb_api;
grant select, insert, update, delete on push_subscriptions to ohb_worker;

-- Un endpoint Push est un identifiant de livraison. S'il change de
-- compte (meme navigateur, autre session), l'ancien rattachement disparait
-- avant l'insert, pour qu'une notif de l'ancien tenant ne parte plus vers
-- le nouvel utilisateur.
create or replace function reassign_push_endpoint()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.push_subscriptions
   where endpoint = new.endpoint and id <> new.id;
  return new;
end;
$$;
revoke all on function reassign_push_endpoint() from public;

create trigger push_subscriptions_reassign
before insert or update of endpoint on push_subscriptions
for each row execute function reassign_push_endpoint();

-- Outbox : une ligne par transition eligible. Le worker la reclame, puis
-- fan-out vers les abonnements. bot_name est un instantane : le bot peut
-- disparaitre avant l'envoi, le titre de la notif reste un nom, jamais
-- un contenu de message.
create table push_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  notification_sequence bigint not null check (notification_sequence > 0),
  event_type text not null check (event_type in (
    'approval.requested', 'run.completed', 'run.error'
  )),
  bot_id uuid,
  bot_name text not null,
  status text not null default 'pending' check (status in (
    'pending', 'sending', 'sent', 'failed', 'skipped'
  )),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, workflow_id, notification_sequence),
  unique (organization_id, id),
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  check (length(bot_name) between 1 and 200),
  check (last_error is null or length(last_error) <= 500)
);

create index push_outbox_claimable_idx
  on push_outbox (available_at, created_at)
  where status in ('pending', 'sending');

comment on table push_outbox is
  'Transitions de workflow eligibles au Web Push. Une ligne par (workflow, notification_sequence) ; le worker fan-out vers push_deliveries. Aucun texte de fil.';

alter table push_outbox enable row level security;
alter table push_outbox force row level security;
create policy push_outbox_worker on push_outbox to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on push_outbox to ohb_worker;

create table push_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  notification_sequence bigint not null check (notification_sequence > 0),
  subscription_id uuid not null,
  status text not null default 'pending' check (status in (
    'pending', 'sent', 'failed', 'gone'
  )),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (workflow_id, notification_sequence, subscription_id),
  unique (organization_id, id),
  foreign key (organization_id, workflow_id)
    references workflows(organization_id, id) on delete cascade,
  foreign key (subscription_id)
    references push_subscriptions(id) on delete cascade
);

create index push_deliveries_subscription_idx
  on push_deliveries (subscription_id, created_at desc);

comment on table push_deliveries is
  'Idempotence du fan-out Web Push : une livraison par (workflow, sequence, abonnement). Un retry du worker retrouve la ligne et ne renvoie pas.';

alter table push_deliveries enable row level security;
alter table push_deliveries force row level security;
create policy push_deliveries_worker on push_deliveries to ohb_worker
  using (true) with check (true);
grant select, insert, update, delete on push_deliveries to ohb_worker;

-- Meme eligibilite que workflowNotificationEligible : salon, routine, ou
-- DM avec autonomie. Seules les transitions que la SPA notifie deja
-- (approval.requested, run.completed, run.error) produisent une alerte.
create or replace function enqueue_push_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot_name text;
  event_type text;
begin
  if not (new.autonomy_enabled or new.kind in ('group', 'routine'))
     or old.status is not distinct from new.status then
    return new;
  end if;

  event_type := case
    when new.status = 'awaiting_approval' then 'approval.requested'
    when new.status = 'completed' then 'run.completed'
    when new.status in ('failed', 'expired', 'unknown') then 'run.error'
    else null
  end;
  if event_type is null then
    return new;
  end if;

  select name into snapshot_name
    from public.bots
   where organization_id = new.organization_id and id = new.root_bot_id;

  insert into public.push_outbox (
    organization_id, workflow_id, notification_sequence,
    event_type, bot_id, bot_name
  ) values (
    new.organization_id, new.id, new.notification_sequence,
    event_type, new.root_bot_id, left(coalesce(nullif(snapshot_name, ''), 'OHB'), 200)
  ) on conflict (organization_id, workflow_id, notification_sequence) do nothing;
  return new;
end;
$$;
revoke all on function enqueue_push_notification() from public;

create trigger workflows_push_notification
after update of status on workflows
for each row execute function enqueue_push_notification();

insert into schema_migrations(version) values ('0039_push_subscriptions')
on conflict (version) do nothing;

commit;
