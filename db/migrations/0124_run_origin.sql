begin;
alter table runs add column origin text check (origin is null or origin in ('bot_greeting'));
insert into schema_migrations(version) values ('0124_run_origin') on conflict (version) do nothing;
commit;
