begin;

-- A service thread (persona draft before a bot exists) has neither a bot
-- nor a group. The historical xor forbade that pair of nulls.
do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.threads'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%bot_id%'
     and pg_get_constraintdef(oid) like '%group_id%'
     and pg_get_constraintdef(oid) like '%is not null%';
  if cname is not null then
    execute format('alter table public.threads drop constraint %I', cname);
  end if;
end $$;

alter table threads add constraint threads_owner_at_most_one check (
  (bot_id is not null)::integer + (group_id is not null)::integer <= 1
);

insert into schema_migrations(version) values ('0045_service_threads')
on conflict (version) do nothing;

commit;
