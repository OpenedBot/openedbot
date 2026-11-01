-- Keep staff authored marketplace entries intact when official fixtures sync at API boot.
begin;

alter table marketplace_entries
  add column staff_override boolean not null default false;

comment on column marketplace_entries.staff_override is
  'True after a staff write; fixture sync skips content updates for this row.';

insert into schema_migrations(version) values ('0113_marketplace_entries_staff_override')
on conflict (version) do nothing;

commit;
