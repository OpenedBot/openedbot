begin;

alter table bots
  add column hermes_profile_managed boolean not null default false;

comment on column bots.hermes_profile_managed is
  'openedbot a créé et possède le profil Hermes nommé correspondant ; false pour un profil explicite ou importé.';

insert into schema_migrations(version) values ('0041_bot_profile_managed')
on conflict (version) do nothing;

commit;
