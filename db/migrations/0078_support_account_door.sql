-- La TROISIÈME porte du guichet : le compte.
--
-- 0076 en posait deux, le condensat du jeton invité et la session staff. Il en
-- manquait une, et son absence se voyait à l'écran : un opérateur connecté qui
-- ouvrait le panneau depuis une autre machine, ou après un effacement des
-- données du site, ne retrouvait RIEN. Son fil existait, le staff y répondait,
-- et lui voyait un guichet vide.
--
-- Le jeton est lié au NAVIGATEUR ; un compte ne l'est pas. Quand la requête
-- porte une session vérifiée, `support-routes.ts` pose donc
-- `app.support_user_id` (`withSupportUser`) et le visiteur voit les fils que
-- son compte a ouverts, où qu'il soit.
--
-- Ce que cette porte n'élargit PAS :
--
--   * elle ne voit que les fils dont `user_id` est renseigné, c'est-à-dire
--     ceux qu'un opérateur connecté a ouverts lui-même. Un fil anonyme reste
--     derrière son seul jeton, même si son adresse ressemble à celle d'un
--     compte : l'adresse n'est pas une preuve d'identité ;
--   * elle ne compare rien d'autre que l'identifiant du compte, et cet
--     identifiant ne vient jamais du corps de la requête. Il est lu par
--     `readOptionalSessionIdentity`, qui valide la session en base et son
--     jeton CSRF sur une méthode non sûre, exactement comme la porte tenant ;
--   * aucune organisation n'entre ici. Un fil de support n'est pas une
--     ressource de tenant, et cette porte ne dit rien des tables qui le sont.
--
-- Les policies étant permissives, celle-ci s'ajoute par un OU aux deux autres.
-- Un GUC absent rend `nullif(...)` nul, donc la comparaison nulle, donc faux :
-- ne pas poser la porte n'ouvre rien.
begin;

-- Idempotent : cette migration a existé une première fois sans sa ligne de
-- version, donc elle peut être rejouée sur une base qui porte déjà la policy.
drop policy if exists support_conversations_account on support_conversations;
create policy support_conversations_account on support_conversations to ohb_api
  using (
    user_id is not null
    and user_id = nullif(current_setting('app.support_user_id', true), '')::uuid
  )
  with check (
    user_id is not null
    and user_id = nullif(current_setting('app.support_user_id', true), '')::uuid
  );

-- L'historique d'un compte se lit dans l'ordre du dernier mouvement. Sans cet
-- index, chaque ouverture du panneau balaie la table.
create index if not exists support_conversations_user_idx
  on support_conversations (user_id, updated_at desc)
  where user_id is not null;

comment on policy support_conversations_account on support_conversations is
  'La porte COMPTE : les fils ouverts par un opérateur connecté suivent son compte, pas son navigateur. `app.support_user_id` est posé par withSupportUser après validation de la session.';

insert into schema_migrations(version) values ('0078_support_account_door')
on conflict (version) do nothing;

commit;
