-- Les captures d'écran du guichet : un visiteur montre son bug.
--
-- Une table à part, et non `attachments` (0006) : celle-là porte
-- `organization_id not null` et une clé étrangère vers `messages`. Au moment
-- où un visiteur écrit au support, il n'y a AUCUNE organisation. Le
-- cloisonnement de ce fil est celui du guichet (jeton, compte, session staff),
-- pas celui d'un tenant.
--
-- Images seulement (`content_type like 'image/%'`), et c'est un choix de
-- produit autant que de sécurité : ce qui entre ici est affiché dans les deux
-- fils, donc il faut savoir l'afficher. Un binaire quelconque serait un
-- fichier que personne ne regarde et que tout le monde stocke.
--
-- Les octets ne sont pas en base : ils vont au magasin de blobs, sous la clé
-- `support/<conversation>/<attachment>`, et la ligne ne garde que l'identité.
begin;

create table support_attachments (
  id uuid primary key,
  conversation_id uuid not null references support_conversations(id) on delete cascade,
  -- Renseigné dès l'insertion : une pièce jointe sans message n'existe pas
  -- dans ce guichet, il n'y a pas de téléversement en deux temps.
  message_id uuid not null references support_messages(id) on delete cascade,
  object_key text not null unique,
  driver text not null check (driver in ('file','r2')),
  name text not null,
  content_type text not null check (content_type like 'image/%'),
  bytes integer not null check (bytes between 1 and 1048576),
  created_at timestamptz not null default now(),
  check (length(name) between 1 and 300),
  check (object_key like ('support/' || conversation_id::text || '/%'))
);

create index support_attachments_message_idx on support_attachments (message_id);

comment on table support_attachments is
  'Les captures jointes à un message de support. Hors tenant, sous la RLS du fil parent. Les octets vivent dans le magasin de blobs, jamais ici.';

alter table support_attachments enable row level security;
alter table support_attachments force row level security;

-- Comme `support_messages` et `support_events` : la policy DÉLÈGUE au parent.
-- « Qui voit quoi » n'est donc défini qu'une seule fois, sur
-- `support_conversations`, et les trois portes (jeton, compte, staff) valent
-- ici sans être répétées.
create policy support_attachments_scope on support_attachments to openedbot_api
  using (exists (select 1 from public.support_conversations c where c.id = conversation_id))
  with check (exists (select 1 from public.support_conversations c where c.id = conversation_id));

create policy support_attachments_worker on support_attachments to openedbot_worker
  using (true) with check (true);

grant select, insert on support_attachments to openedbot_api;
grant select, insert, update, delete on support_attachments to openedbot_worker;

-- La file de suppression de blobs devient celle de TOUT le produit.
--
-- `tenant_blob_deletions` (0002) est la seule file durable de suppression
-- d'octets : elle est relue, réessayée et observée par le worker
-- (`maintenance/deletion.ts`). En écrire une seconde pour le guichet, c'est
-- s'engager à repayer les mêmes bugs de bail et de reprise.
--
-- Deux contraintes l'empêchaient d'accueillir une clé de support : un
-- `organization_id` obligatoire, et un motif de clé qui n'admettait que le
-- préfixe `org/`. Les deux se relâchent ici SANS rien ouvrir : la clé doit
-- toujours être l'une des deux formes connues, et une clé `org/` doit toujours
-- nommer l'organisation qu'elle dit.
alter table tenant_blob_deletions alter column organization_id drop not null;

do $blobs$
declare
  constraint_name text;
begin
  -- Les checks de 0002 sont anonymes, donc nommés par PostgreSQL
  -- (`tenant_blob_deletions_check`, `_check1`…). Les retirer par leur nom
  -- généré serait un pari sur l'ordre de déclaration : ils sont retrouvés par
  -- ce qu'ils CONTIENNENT.
  for constraint_name in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
     where rel.relname = 'tenant_blob_deletions'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%object_key%'
       and pg_get_constraintdef(con.oid) not like '%length(object_key)%'
  loop
    execute format('alter table tenant_blob_deletions drop constraint %I', constraint_name);
  end loop;
end;
$blobs$;

alter table tenant_blob_deletions
  add constraint tenant_blob_deletions_key_shape check (
    object_key ~ '^org/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or object_key ~ '^support/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  );

alter table tenant_blob_deletions
  add constraint tenant_blob_deletions_owner check (
    -- Une clé de tenant nomme SON organisation ; une clé de support n'en a
    -- aucune. L'un ou l'autre, jamais un mélange.
    (object_key like 'org/%' and organization_id is not null
      and object_key like ('org/' || organization_id::text || '/%'))
    or (object_key like 'support/%' and organization_id is null)
  );

comment on table tenant_blob_deletions is
  'La file durable des octets à supprimer, pour tout le produit : clés de tenant (org/…) et clés du guichet de support (support/…). Drainée par le worker avec bail et réessai.';

-- La table est sous RLS FORCÉE et n'avait qu'une policy `openedbot_worker` : sans
-- celle-ci, l'API ne pourrait rien y écrire. Elle est bornée aux clés du
-- guichet : l'API ne voit ni n'écrit aucune clé de tenant par cette porte,
-- c'est le worker qui les met en file quand une organisation part.
create policy support_blob_deletions_api on tenant_blob_deletions to openedbot_api
  using (object_key like 'support/%' and organization_id is null)
  with check (object_key like 'support/%' and organization_id is null);

grant select, insert, update, delete on tenant_blob_deletions to openedbot_api;

insert into schema_migrations(version) values ('0079_support_attachments')
on conflict (version) do nothing;

commit;
