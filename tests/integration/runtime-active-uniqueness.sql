-- Un seul runtime ACTIF par organisation, garanti par la BASE et non par la
-- route qui bascule.
--
-- Le worker joint `runtimes` sans ORDER BY (modules/execution/src/application/queue.ts,
-- runner.ts) : si deux lignes pouvaient etre actives, il choisirait au hasard le
-- runtime qui execute les runs d un client. La preuve tente donc la double
-- activation et exige un refus.
--
-- Second invariant : un runtime revoque ne peut pas rester actif, sinon le
-- worker joindrait une ligne que l API considere supprimee.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table runtime_proof (second_active text, revoked_active text, cross_tenant int);
insert into runtime_proof values ('allowed', 'allowed', -1);

insert into runtimes (
  id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, is_active
) values
  ('60000000-0000-4000-8000-000000000061', '20000000-0000-4000-8000-000000000002',
   'VPS', 'https://hermes.example.test', 'c', 'n', 't', true),
  ('60000000-0000-4000-8000-000000000062', '20000000-0000-4000-8000-000000000002',
   'Local', 'https://local.example.test', 'c', 'n', 't', false);

do $$
begin
  begin
    update runtimes set is_active = true
     where id = '60000000-0000-4000-8000-000000000062';
  exception when unique_violation then
    update runtime_proof set second_active = 'refused';
  end;

  begin
    update runtimes set revoked_at = now()
     where id = '60000000-0000-4000-8000-000000000061';
  exception when check_violation then
    update runtime_proof set revoked_active = 'refused';
  end;
end
$$;

grant select, insert, update on runtime_proof to openedbot_api;
set role openedbot_api;
-- \g /dev/null : le verdict doit rester la SEULE ligne de sortie.
select set_config('app.organization_id', '10000000-0000-4000-8000-000000000001', false) \g /dev/null
update runtime_proof set cross_tenant = (select count(*) from runtimes);
reset role;

-- Une ligne unique : les tags de commande de psql rendent illisible tout
-- comptage de lignes en queue de sortie.
select second_active || '/' || revoked_active || '/' || cross_tenant from runtime_proof;
