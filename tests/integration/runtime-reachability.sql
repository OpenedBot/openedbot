-- Forme d un runtime selon son mode de jonction (0024), tenue par la BASE.
--
-- Invariant : openedbot ne compose aucune URL vers un hote joint par le
-- connecteur. Si une ligne connector pouvait porter un endpoint, une API
-- compromise saurait ou frapper ; si une ligne direct pouvait perdre le sien,
-- le worker composerait une URL nulle. La preuve tente les trois formes
-- interdites et exige un refus a chaque fois.
--
-- Seconde porte RLS : le connecteur qui se reconnecte n a aucune session,
-- seulement le hash de son jeton de lien. Avec le hash exact, il voit SA ligne
-- et rien d autre ; sans rien, il ne voit rien. Le worker, lui, lit
-- link_last_seen_at pour distinguer un lien vivant d un lien perdu.
--
-- Piege du fichier appelant : pas d apostrophe isolee dans les commentaires.

create temp table reachability_proof (
  connector_with_endpoint text, direct_without_endpoint text, connector_without_link text,
  enrollment_connector_with_endpoint text, by_link int, blind int, worker_seen text,
  worker_epoch text
);
insert into reachability_proof values ('allowed', 'allowed', 'allowed', 'allowed', -1, -1, 'unseen', 'unread');

-- Une ligne connector bien formee, inactive pour ne pas disputer l index
-- partiel a la preuve d activation qui precede.
insert into runtimes (
  id, organization_id, name, reachability, link_token_hash, link_last_seen_at, is_active
) values (
  '60000000-0000-4000-8000-000000000071', '20000000-0000-4000-8000-000000000002',
  'Connector', 'connector', 'link-hash-a', now(), false
);

do $$
begin
  begin
    insert into runtimes (
      id, organization_id, name, reachability, link_token_hash, endpoint, is_active
    ) values (
      '60000000-0000-4000-8000-000000000072', '20000000-0000-4000-8000-000000000002',
      'Connector with URL', 'connector', 'link-hash-b', 'https://hidden.example.test', false
    );
  exception when check_violation then
    update reachability_proof set connector_with_endpoint = 'refused';
  end;

  begin
    insert into runtimes (
      id, organization_id, name, reachability, token_ciphertext, token_nonce, token_tag, is_active
    ) values (
      '60000000-0000-4000-8000-000000000073', '20000000-0000-4000-8000-000000000002',
      'Direct without URL', 'direct', 'c', 'n', 't', false
    );
  exception when check_violation then
    update reachability_proof set direct_without_endpoint = 'refused';
  end;

  begin
    insert into runtimes (
      id, organization_id, name, reachability, is_active
    ) values (
      '60000000-0000-4000-8000-000000000074', '20000000-0000-4000-8000-000000000002',
      'Connector without link', 'connector', false
    );
  exception when check_violation then
    update reachability_proof set connector_without_link = 'refused';
  end;

  begin
    insert into runtime_enrollments (
      id, secret_hash, reachability, endpoint, runtime_name, verification_code, expires_at
    ) values (
      '70000000-0000-4000-8000-000000000081', 'secret-hash-reach', 'connector',
      'https://hidden.example.test', 'Connector enrollment', 'ABC234', now() + interval '5 minutes'
    );
  exception when check_violation then
    update reachability_proof set enrollment_connector_with_endpoint = 'refused';
  end;
end
$$;

grant select, insert, update on reachability_proof to ohb_api, ohb_worker;

-- Le connecteur, sans session, avec le hash exact : sa ligne et seulement elle.
set role ohb_api;
select set_config('app.organization_id', '', false) \g /dev/null
select set_config('app.session_credential_hash', 'link-hash-a', false) \g /dev/null
update reachability_proof set by_link = (select count(*) from runtimes);
reset role;

-- Ni session ni hash : rien, pas meme l existence de la ligne.
set role ohb_api;
select set_config('app.organization_id', '', false) \g /dev/null
select set_config('app.session_credential_hash', '', false) \g /dev/null
update reachability_proof set blind = (select count(*) from runtimes);
reset role;

-- Le worker lit le dernier signe de vie du lien.
set role ohb_worker;
update reachability_proof set worker_seen = (
  select case when link_last_seen_at is not null then 'visible' else 'null' end
    from runtimes where id = '60000000-0000-4000-8000-000000000071'
);
reset role;

-- OHB-138 : le broker incremente toolset_epoch sous la porte du tenant apres
-- une ecriture d inventaire relayee ; le worker le relit avec le contexte du run.
set role ohb_api;
select set_config('app.session_credential_hash', '', false) \g /dev/null
select set_config('app.organization_id', '20000000-0000-4000-8000-000000000002', false) \g /dev/null
update runtimes set toolset_epoch = toolset_epoch + 1
 where id = '60000000-0000-4000-8000-000000000071' and link_token_hash = 'link-hash-a';
select set_config('app.organization_id', '', false) \g /dev/null
reset role;
set role ohb_worker;
update reachability_proof set worker_epoch = (
  select toolset_epoch::text from runtimes where id = '60000000-0000-4000-8000-000000000071'
);
reset role;

select connector_with_endpoint || '/' || direct_without_endpoint || '/' || connector_without_link
       || '/' || enrollment_connector_with_endpoint || '/' || by_link || '/' || blind || '/' || worker_seen || '/' || worker_epoch
  from reachability_proof;
