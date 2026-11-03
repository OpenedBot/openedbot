-- OHB-25 : api_instances is an ops table, no tenant RLS.
-- ohb_api writes, ohb_worker reads, worker insert is denied.
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table api_instances_proof (
  rls text,
  api_write int,
  worker_read int,
  worker_write text
);
insert into api_instances_proof values ('unset', -1, -1, 'unset');

update api_instances_proof
   set rls = (select case when c.relrowsecurity then 'on' else 'off' end
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'api_instances');

grant select, insert, update on api_instances_proof to ohb_api, ohb_worker;

set role ohb_api;
insert into api_instances (instance_id, internal_url)
values ('api-proof-a', 'http://10.0.0.2:8790')
on conflict (instance_id) do update set last_seen_at = now(), stopped_at = null;
update api_instances_proof set api_write = (select count(*) from api_instances where instance_id = 'api-proof-a');
reset role;

set role ohb_worker;
update api_instances_proof set worker_read = (select count(*) from api_instances where instance_id = 'api-proof-a');
do $proof$
begin
  insert into api_instances (instance_id, internal_url)
  values ('api-proof-worker', 'http://10.0.0.3:8790');
  update api_instances_proof set worker_write = 'allowed';
exception
  when insufficient_privilege then
    update api_instances_proof set worker_write = 'denied';
end;
$proof$;
reset role;

select rls || '/' || api_write || '/' || worker_read || '/' || worker_write
  from api_instances_proof;
