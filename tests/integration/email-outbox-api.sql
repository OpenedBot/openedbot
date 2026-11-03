-- La frontière de la file d e-mails (0064) : l API DÉPOSE, elle ne LIT pas.
--
-- Quatre faits, dans l ordre du resultat attendu :
--   1. ohb_api insere une ligne (waitlist_confirmation) : accepte
--   2. ohb_api relit la file : refuse (aucun grant select), 42501
--   3. ohb_api modifie une ligne : refuse (aucun grant update), 42501
--   4. ohb_worker voit bien la ligne deposee par l API
--
-- Le genre est borne par la contrainte : un genre inconnu est refuse. C est ce
-- qui empeche une route de semer un e-mail que le worker ne saurait pas rendre.
create temp table email_outbox_proof (inserted text, api_read text, api_update text, worker_read text);
grant insert, update, select on email_outbox_proof to ohb_api;
grant insert, update, select on email_outbox_proof to ohb_worker;

set role ohb_api;
insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
values ('60000000-0000-4000-8000-000000000001', 'waitlist_confirmation',
        'waitlist:proof@example.test', 'proof@example.test', 'fr', '{}'::jsonb);
insert into email_outbox_proof (inserted) values ('inserted');

do $$
begin
  perform count(*) from email_outbox;
  update email_outbox_proof set api_read = 'read';
exception when insufficient_privilege then
  update email_outbox_proof set api_read = 'denied';
end;
$$;

do $$
begin
  update email_outbox set status = 'sent' where dedupe_key = 'waitlist:proof@example.test';
  update email_outbox_proof set api_update = 'updated';
exception when insufficient_privilege then
  update email_outbox_proof set api_update = 'denied';
end;
$$;

reset role;
set role ohb_worker;
update email_outbox_proof
   set worker_read = (select count(*)::text from email_outbox
                       where dedupe_key = 'waitlist:proof@example.test');
reset role;

-- Le journal est hors tenant : l API écrit et lit pour le futur backoffice,
-- tandis que le worker écrit ses transitions sans pouvoir les relire. Les
-- preuves ne mettent volontairement aucune adresse dans la table.
create temp table email_outbox_events_proof (
  api_insert text,
  api_read text,
  worker_insert text,
  worker_read text
);
grant insert, update, select on email_outbox_events_proof to ohb_api;
grant insert, update, select on email_outbox_events_proof to ohb_worker;
insert into email_outbox_events_proof default values;

set role ohb_api;
insert into email_outbox_events (id, outbox_id, kind, event, detail)
values (
  '67000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  'waitlist_confirmation',
  'queued',
  '{"domain":"example.test"}'::jsonb
);
update email_outbox_events_proof set api_insert = 'inserted';
update email_outbox_events_proof
   set api_read = (select count(*)::text from email_outbox_events
                    where id = '67000000-0000-4000-8000-000000000001');
reset role;

set role ohb_worker;
insert into email_outbox_events (id, outbox_id, kind, event, attempt)
values (
  '67000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000001',
  'waitlist_confirmation',
  'sent',
  1
);
update email_outbox_events_proof set worker_insert = 'inserted';
do $$
begin
  perform count(*) from email_outbox_events;
  update email_outbox_events_proof set worker_read = 'read';
exception when insufficient_privilege then
  update email_outbox_events_proof set worker_read = 'denied';
end;
$$;
reset role;

do $$
begin
  if (select api_insert || '/' || api_read || '/' || worker_insert || '/' || worker_read
        from email_outbox_events_proof) <> 'inserted/1/inserted/denied' then
    raise exception 'unexpected email_outbox_events rights proof';
  end if;
end;
$$;

delete from email_outbox_events
 where id in (
   '67000000-0000-4000-8000-000000000001',
   '67000000-0000-4000-8000-000000000002'
 );
delete from email_outbox where dedupe_key = 'waitlist:proof@example.test';
select inserted || '/' || api_read || '/' || api_update || '/' || worker_read from email_outbox_proof;
