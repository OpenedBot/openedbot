begin;

-- Depart d un membre : ses abonnements Web Push partent avec la revocation.
--
-- La membership est revoquee (revoked_at), pas supprimee : la FK
-- (organization_id, user_id) de push_subscriptions (0039) ne cascade donc
-- pas. Le DELETE applicatif de removeMember etait un no-op silencieux : la
-- policy push_subscriptions_owner exige app.authenticating_user_id, que
-- withTenant ne pose pas, et ce serait de toute facon l acteur, pas le membre
-- retire. Meme reponse que pour APNs (memberships_drop_apns_devices, 0108) :
-- la cascade vit en base, dans un trigger SECURITY DEFINER.

create or replace function drop_push_subscriptions_of_revoked_member()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.push_subscriptions
     where organization_id = new.organization_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function drop_push_subscriptions_of_revoked_member() from public;

create trigger memberships_drop_push_subscriptions
after update of revoked_at on memberships
for each row execute function drop_push_subscriptions_of_revoked_member();

-- Rattrapage : les abonnements des membres deja revoques, que l ancien
-- DELETE applicatif a laisses en place.
delete from push_subscriptions s
 using memberships m
 where m.organization_id = s.organization_id and m.user_id = s.user_id
   and m.revoked_at is not null;

insert into schema_migrations(version) values ('0170_push_subscriptions_member_revocation')
on conflict (version) do nothing;

commit;
