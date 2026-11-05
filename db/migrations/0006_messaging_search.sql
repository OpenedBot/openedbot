begin;

-- Messagerie : messages ordonnés par séquence durable, compteurs par fil,
-- pièces jointes, réactions, curseurs de lecture des membres de salon, et
-- la recherche globale normalisée (fonctions + index GIN).

-- `created_at default now()` est l'heure de début de transaction, pas une clé
-- d'ordre. `sequence` est la séquence durable par fil ; le snapshot d'auteur
-- (original_author_bot_id/name) est immuable et sans FK : la suppression
-- ultérieure du bot ne peut pas effacer l'attribution une seconde fois.
create table messages (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  run_id uuid,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  author_bot_id uuid,
  created_at timestamptz not null default now(),
  sequence bigint not null,
  original_author_bot_id uuid,
  original_author_name text,
  reply_to_id uuid,
  unique (organization_id, id),
  foreign key (organization_id, thread_id) references threads(organization_id, id) on delete cascade,
  foreign key (organization_id, run_id) references runs(organization_id, id),
  foreign key (organization_id, author_bot_id) references bots(organization_id, id) on delete set null (author_bot_id),
  constraint messages_sequence_nonnegative check (sequence >= 0)
);

create index messages_thread_created_idx on messages (organization_id, thread_id, created_at);
create unique index messages_thread_sequence_idx
  on messages (organization_id, thread_id, sequence);

-- Cette clé unique existe uniquement comme cible des FK composites qui
-- imposent « même tenant, même fil » à la frontière base (réponses,
-- réactions, versions) ; les ids sont déjà globalement uniques.
create unique index messages_tenant_thread_id_idx
  on messages (organization_id, thread_id, id);

alter table messages
  add constraint messages_reply_same_thread_fk
  foreign key (organization_id, thread_id, reply_to_id)
  references messages (organization_id, thread_id, id)
  on delete restrict;

create table thread_message_counters (
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  next_sequence bigint not null default 0 check (next_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, thread_id),
  foreign key (organization_id, thread_id)
    references threads(organization_id, id) on delete cascade
);

create or replace function assign_message_sequence_and_author()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.sequence is null then
    insert into public.thread_message_counters as counter (
      organization_id, thread_id, next_sequence, updated_at
    ) values (
      new.organization_id, new.thread_id, 1, now()
    )
    on conflict (organization_id, thread_id) do update
      set next_sequence = counter.next_sequence + 1,
          updated_at = now()
    returning next_sequence - 1 into new.sequence;
  else
    insert into public.thread_message_counters as counter (
      organization_id, thread_id, next_sequence, updated_at
    ) values (
      new.organization_id, new.thread_id, new.sequence + 1, now()
    )
    on conflict (organization_id, thread_id) do update
      set next_sequence = greatest(counter.next_sequence, excluded.next_sequence),
          updated_at = now();
  end if;

  if new.original_author_bot_id is null then
    new.original_author_bot_id := new.author_bot_id;
    if new.original_author_bot_id is null and new.role = 'assistant' then
      select thread.bot_id into new.original_author_bot_id
        from public.threads thread
       where thread.organization_id = new.organization_id and thread.id = new.thread_id;
    end if;
  end if;

  if new.original_author_name is null and new.original_author_bot_id is not null then
    select bot.name into new.original_author_name
      from public.bots bot
     where bot.organization_id = new.organization_id and bot.id = new.original_author_bot_id;
  end if;

  return new;
end;
$$;

create trigger messages_assign_sequence_and_author
before insert on messages
for each row execute function assign_message_sequence_and_author();

create table attachments (
  id uuid primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  message_id uuid,
  object_key text not null unique,
  driver text not null check (driver in ('file','r2')),
  name text not null,
  content_type text not null,
  kind text not null check (kind in ('image','document')),
  bytes integer not null check (bytes between 1 and 1048576),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, message_id) references messages(organization_id, id) on delete cascade
);
create index attachments_quota_idx on attachments (organization_id) where deleted_at is null;

-- Les réactions sont des lignes possédées par membre, pas un blob JSON
-- mutable : add/remove concurrents restent atomiques, les retries idempotents.
create table message_reactions (
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_id uuid not null,
  message_id uuid not null,
  user_id uuid not null,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, message_id, emoji),
  foreign key (organization_id, user_id)
    references memberships(organization_id, user_id) on delete cascade,
  foreign key (organization_id, thread_id, message_id)
    references messages(organization_id, thread_id, id) on delete cascade
);

create index message_reactions_message_idx
  on message_reactions (organization_id, thread_id, message_id, emoji);

create table group_member_read_positions (
  organization_id uuid not null references organizations(id) on delete cascade,
  group_id uuid not null,
  bot_id uuid not null,
  last_message_sequence bigint not null default -1 check (last_message_sequence >= -1),
  updated_at timestamptz not null default now(),
  primary key (organization_id, group_id, bot_id),
  foreign key (organization_id, group_id, bot_id)
    references group_members(organization_id, group_id, bot_id) on delete cascade
);

-- Recherche globale. Le dictionnaire `simple` ne replie ni accents ni
-- ligatures : le repli est indépendant de la locale et des extensions : NFKD
-- pour les diacritiques latins, remplacements explicites pour ce que NFKD ne
-- décompose pas, translation ASCII fixe pour la casse.
create or replace function public.openedbot_global_search_normalize(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = pg_catalog, public
as $$
  select translate(
    regexp_replace(
      normalize(
        replace(replace(
          replace(replace(
            replace(replace(
              replace(replace(
                replace(replace(
                  replace(replace(
                    replace(replace(input, 'Œ', 'oe'), 'œ', 'oe'),
                    'Æ', 'ae'), 'æ', 'ae'),
                  'ẞ', 'ss'), 'ß', 'ss'),
                'Þ', 'th'), 'þ', 'th'),
              'Ø', 'o'), 'ø', 'o'),
            'Ł', 'l'), 'ł', 'l'),
          'Đ', 'd'), 'đ', 'd'),
        NFKD
      ) collate "C",
      U&'[\0300-\036f]' collate "C",
      '',
      'g'
    ),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZÐð',
    'abcdefghijklmnopqrstuvwxyzdd'
  )
$$;

-- Une seule projection immuable est partagée par l'index GIN et la requête de
-- la route. C'est une allow-list : texte et noms publics de pièces jointes
-- uniquement : un nouveau type de part persisté ne peut jamais rendre les
-- arguments de reasoning/outils cherchables par accident.
create or replace function public.openedbot_visible_message_search_text(content jsonb)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select public.openedbot_global_search_normalize(coalesce(string_agg(
    case
      when part.value->>'type' = 'text' then coalesce(part.value->>'text', '')
      when part.value->>'type' = 'attachment' then coalesce(part.value->>'name', '')
      else null
    end,
    E'\n' order by part.ordinality
  ), ''))
  from jsonb_array_elements(
    case when jsonb_typeof(content) = 'array' then content else '[]'::jsonb end
  ) with ordinality as part(value, ordinality)
$$;

create index messages_global_search_idx
  on messages using gin (
    to_tsvector('simple'::regconfig, public.openedbot_visible_message_search_text(content))
  );

create index threads_global_search_idx
  on threads using gin (
    to_tsvector(
      'simple'::regconfig,
      public.openedbot_global_search_normalize(coalesce(title, ''))
    )
  );

alter table messages enable row level security;
alter table messages force row level security;
alter table thread_message_counters enable row level security;
alter table thread_message_counters force row level security;
alter table attachments enable row level security;
alter table attachments force row level security;
alter table message_reactions enable row level security;
alter table message_reactions force row level security;
alter table group_member_read_positions enable row level security;
alter table group_member_read_positions force row level security;

create policy messages_tenant on messages to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy messages_worker on messages to openedbot_worker using (true) with check (true);

create policy thread_message_counters_tenant on thread_message_counters to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy thread_message_counters_worker on thread_message_counters to openedbot_worker
  using (true) with check (true);

create policy attachments_tenant on attachments to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy attachments_worker on attachments to openedbot_worker using (true) with check (true);

create policy message_reactions_tenant on message_reactions to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy message_reactions_worker on message_reactions to openedbot_worker
  using (true) with check (true);

create policy group_member_read_positions_tenant on group_member_read_positions to openedbot_api
  using (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
create policy group_member_read_positions_worker on group_member_read_positions to openedbot_worker
  using (true) with check (true);

grant select, insert, update, delete on messages, attachments to openedbot_api;
grant select, insert, update, delete on messages, attachments to openedbot_worker;
grant select, insert, update, delete on thread_message_counters to openedbot_api;
grant select, insert, update, delete on thread_message_counters to openedbot_worker;
grant select, insert, update, delete on message_reactions to openedbot_api;
grant select, insert, update, delete on message_reactions to openedbot_worker;
grant select, insert, update, delete on group_member_read_positions to openedbot_api;
grant select, insert, update, delete on group_member_read_positions to openedbot_worker;

insert into schema_migrations(version) values ('0006_messaging_search')
on conflict (version) do nothing;

commit;
