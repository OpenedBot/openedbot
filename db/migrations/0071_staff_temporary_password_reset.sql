-- Le backoffice peut REPOSER un mot de passe temporaire sur un compte qui
-- existe déjà (`staff-routes.ts`,
-- `POST /api/staff/users/:userId/temporary-password`). C'est le geste du
-- support : le courrier de création n'est jamais arrivé, ou le mot de passe a
-- été perdu avant la première connexion.
--
-- Deux faits nouveaux, et rien d'autre.
--
-- 1. Le genre d'e-mail qui porte ce second mot de passe. Il est DISTINCT de
--    `staff_account_created` parce qu'il ne dit pas la même chose : ici
--    l'ancien mot de passe ne vaut plus rien et les sessions ouvertes ont été
--    fermées. La contrainte de genre reste la jumelle SQL de
--    `TRANSACTIONAL_EMAIL_KINDS` (`contracts/api/src/email-kinds.ts`) :
--    les deux listes se modifient ensemble, ou pas du tout.
--
-- 2. `staff_reset_user_password()`, qui fait le geste ENTIER en une fois.
--    L'API ne peut pas l'écrire elle-même : `users` n'a pas de RLS, mais
--    `sessions` en a une, et ses seules portes sont la session courante
--    (`sessions_credential`) ou son propre utilisateur (`sessions_owner_*`,
--    0019). Le staff n'est ni l'un ni l'autre. La fonction est donc
--    `security definer`, gardée par `app.staff_user_id` comme
--    `staff_issue_user_impersonation_claim` (0030), et elle tient les trois
--    écritures dans la MÊME transaction : le nouveau hachage, le drapeau
--    `must_change_password`, la fermeture des sessions encore ouvertes. Un mot
--    de passe remplacé qui laisserait vivre les anciennes sessions n'aurait
--    rien réinitialisé.
--
-- Elle ne LÈVE pas d'exception pour dire non : elle rend un `status` que
-- l'API traduit en refus HTTP, parce que ces deux refus-là sont des réponses
-- normales, pas des pannes.
--
-- - `google_only` : le compte n'a que Google pour entrer. Lui poser un mot de
--   passe temporaire lèverait `must_change_password`, et l'application lui
--   demanderait de changer un mot de passe qu'il n'a jamais choisi, à chaque
--   connexion Google, jusqu'à ce qu'il aille chercher celui-ci dans sa boîte.
--   C'est la même règle qu'à la création (`staff-account-provisioning.ts`) :
--   un compte Google ne reçoit pas de mot de passe ;
-- - `no_organization` : le compte n'appartient à aucun espace vivant.
--   `verifyCredentials` le refuserait en `MEMBERSHIP_REQUIRED` quel que soit
--   son mot de passe. Le geste à faire est de lui rouvrir un espace
--   (`POST /api/staff/users`), pas de lui envoyer un secret inutile.
--
-- Aucune ligne n'est écrite dans ces deux cas.
begin;

alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in (
    'account_purge_completed',
    'provider_quota_reached',
    'waitlist_confirmation',
    'waitlist_access_granted',
    'waitlist_access_tier_changed',
    'waitlist_access_revoked',
    'staff_account_created',
    'staff_password_reset'
  ));

create or replace function staff_reset_user_password(
  p_user_id uuid,
  p_password_hash text
)
returns table (status text, email text, organization_id uuid, revoked_sessions integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
  target_email text;
  target_has_password boolean;
  target_has_google boolean;
  living_organization_id uuid;
  closed_sessions integer := 0;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;

  if staff_id is null or not exists (
    select 1 from public.staff_users su
     where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;

  -- Le hachage vient de l'API (argon2id). Un paramètre vide ou trop court ne
  -- peut pas en être un : l'écrire condamnerait le compte à ne plus jamais
  -- pouvoir se connecter, et la ligne serait indiscernable d'un vrai hachage.
  if p_password_hash is null or length(p_password_hash) < 32 then
    raise exception 'a password hash is required' using errcode = '22023';
  end if;

  select u.email, (u.password_hash is not null), (u.google_subject is not null)
    into target_email, target_has_password, target_has_google
    from public.users u
   where u.id = p_user_id;

  -- Compte inconnu : AUCUNE ligne. L'API répond 404 et n'a rien à distinguer.
  if target_email is null then
    return;
  end if;

  if target_has_google and not target_has_password then
    return query select 'google_only'::text, target_email, null::uuid, 0;
    return;
  end if;

  select m.organization_id
    into living_organization_id
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
   where m.user_id = p_user_id
     and o.deleted_at is null
   order by m.created_at asc, m.organization_id asc
   limit 1;

  if living_organization_id is null then
    return query select 'no_organization'::text, target_email, null::uuid, 0;
    return;
  end if;

  update public.users
     set password_hash = p_password_hash,
         must_change_password = true,
         updated_at = now()
   where id = p_user_id;

  -- `password_change` est un motif déjà déclaré par la contrainte de 0019 :
  -- c'est bien ce qui vient de se passer, vu de la session fermée.
  with closed as (
    update public.sessions
       set revoked_at = now(), revoked_reason = 'password_change'
     where user_id = p_user_id and revoked_at is null
    returning 1
  )
  select count(*)::integer into closed_sessions from closed;

  return query select 'reset'::text, target_email, living_organization_id, closed_sessions;
end;
$$;

comment on function staff_reset_user_password(uuid, text) is
  'Repose un mot de passe temporaire sur un compte existant, depuis le backoffice : nouveau hachage, drapeau must_change_password, et fermeture de toutes les sessions encore ouvertes, dans une seule transaction. Gardée par app.staff_user_id. Ne rend AUCUNE ligne pour un compte inconnu, et refuse sans rien écrire un compte qui n''entre que par Google (google_only) ou qui n''a plus d''espace vivant (no_organization).';

revoke all on function staff_reset_user_password(uuid, text) from public;
grant execute on function staff_reset_user_password(uuid, text) to openedbot_api;

insert into schema_migrations(version) values ('0071_staff_temporary_password_reset')
on conflict (version) do nothing;

commit;
