begin;

-- US6 : le journal d'audit unifié.
--
-- Conception : PAS de cinquième table. Les quatre journaux qui existent déjà
-- (`staff_impersonation_claims`, `runtime_link_events`, `decisions`,
-- `webhook_management_operations`) restent la source de vérité ; `audit_log`
-- est une VUE de lecture qui les normalise sur un jeu de colonnes commun.
-- Recopier les événements dans une table dédiée coûterait une duplication,
-- une dérive (deux vérités qui divergent au premier writer oublié) et une
-- double rétention à tenir. Une vue n'a aucun de ces trois défauts.
--
-- Vie privée : `details` ne porte QUE des métadonnées : identifiants
-- techniques, énumérations, et l'IP / l'agent là où la source les journalise
-- déjà. Sont exclues explicitement, source par source :
--   * `staff_impersonation_claims.claim_token_hash` : condensat d'un code à
--     usage unique, et clé de la politique RLS d'échange ;
--   * `decisions.envelope` : l'enveloppe signée transporte la commande et la
--     description soumises à l'humain, donc du contenu utilisateur ;
--   * `decisions.previous_hash` / `decisions.entry_hash`: maillons de la
--     chaîne signée ; ils ne se lisent qu'avec la chaîne entière, jamais
--     isolés dans un journal de lecture ;
--   * `webhook_management_operations.request_hash` et le quadruplet
--     `secret_ciphertext` / `secret_nonce` / `secret_tag` / `secret_key_id`,
--     matériel de récupération d'un secret bearer.
-- Aucune adresse e-mail, aucun contenu de message, aucun jeton et aucun
-- condensat de credential ne traverse donc cette vue.
--
-- RLS : une vue PostgreSQL ne porte PAS de politique propre : elle est
-- évaluée, par défaut, avec les droits de SON PROPRIÉTAIRE. Comme les
-- migrations sont jouées par le superutilisateur, une vue laissée en mode
-- « definer » contournerait la RLS de ses tables et servirait à n'importe
-- quel tenant les lignes de tous les autres. `security_invoker = true`
-- (PostgreSQL 15+, déjà requis par la syntaxe `on delete set null (col)` de
-- 0011) rend la vue transparente : chaque table sous-jacente applique sa
-- propre politique à l'APPELANT, et `openedbot_api` avec `app.organization_id` posé
-- ne voit que ses propres lignes.
create view audit_log
with (security_invoker = true)
as
  -- Ouverture d'une session d'assistance staff. La table porte bien un
  -- `organization_id` non nul (identifiants d'audit détachés, cf. 0029) :
  -- aucune jointure n'est nécessaire pour situer le tenant.
  -- Une demande vit deux moments (émission du code, échange contre une
  -- session) ; on expose UNE ligne par demande, datée du moment le plus
  -- récent atteint, et les deux horodatages restent lisibles dans `details`.
  select
    coalesce(c.claimed_at, c.created_at) as occurred_at,
    c.organization_id                     as organization_id,
    'staff_impersonation'::text           as source,
    case when c.claimed_at is not null
      then 'staff_impersonation.claimed'
      else 'staff_impersonation.issued'
    end::text                             as action,
    'staff'::text                         as actor_kind,
    c.staff_user_id                       as actor_id,
    'user'::text                          as subject_kind,
    c.user_id                             as subject_id,
    jsonb_build_object(
      'claimId', c.id,
      'issuedAt', c.created_at,
      'expiresAt', c.expires_at,
      'claimedAt', c.claimed_at,
      'sessionId', c.session_id
    )                                     as details
  from public.staff_impersonation_claims c

  union all

  -- Journal du lien connecteur (0027). `kind` est déjà une énumération
  -- fermée ; l'IP et l'agent sont les métadonnées qui rendent un
  -- `hijack_suspected` exploitable, et la source les journalise déjà.
  select
    e.occurred_at,
    e.organization_id,
    'runtime_link'::text,
    ('runtime_link.' || e.kind)::text,
    'system'::text,
    null::uuid,
    'runtime'::text,
    e.runtime_id,
    jsonb_build_object(
      'eventId', e.id,
      'kind', e.kind,
      'ip', e.ip,
      'agent', e.agent,
      'previousIp', e.previous_ip
    )
  from public.runtime_link_events e

  union all

  -- Décisions d'approbation (0007, détachées par 0011). L'acteur est nul
  -- quand la décision vient d'une expiration côté worker, pas d'un humain.
  select
    d.created_at,
    d.organization_id,
    'decision'::text,
    ('decision.' || d.choice)::text,
    case when d.actor_user_id is not null then 'user' else 'system' end::text,
    d.actor_user_id,
    'run'::text,
    d.run_id,
    jsonb_build_object(
      'decisionId', d.id,
      'choice', d.choice,
      'threadId', d.thread_id,
      'runId', d.run_id,
      'approvalRequestId', d.approval_request_id,
      'chainSequence', d.chain_sequence
    )
  from public.decisions d

  union all

  -- Création et rotation d'un endpoint webhook (0010). `operation` est déjà
  -- de la forme `webhook.create` / `webhook.rotate`.
  select
    w.created_at,
    w.organization_id,
    'webhook_management'::text,
    w.operation::text,
    'user'::text,
    w.user_id,
    'webhook_endpoint'::text,
    w.endpoint_id,
    jsonb_build_object(
      'operationId', w.id,
      'operation', w.operation,
      'idempotencyKey', w.idempotency_key,
      'recoverableUntil', w.recoverable_until
    )
  from public.webhook_management_operations w;

comment on view audit_log is
  'Journal d''audit unifié : vue de lecture normalisée par-dessus les quatre journaux existants (assistance staff, lien connecteur, décisions d''approbation, management des webhooks). Elle est lue par les ADMINS DU TENANT — `security_invoker` fait appliquer la RLS de chaque table sous-jacente à l''appelant, donc une organisation ne voit que ses propres lignes — ET par le STAFF, tous tenants confondus, via `staff_audit_log()`. Point de conception : la rétention d''un journal d''audit est LONGUE (au moins un an), volontairement distincte de la purge analytique à 90 jours de `analytics_events` ; ce ne sont pas les mêmes obligations, et la vue n''ajoute aucune rétention propre — elle hérite de celle de ses sources, qu''aucun purgeur ne doit raccourcir. Aucune donnée personnelle ni aucun secret ne transite : ni e-mail, ni contenu de message, ni jeton, ni condensat de credential.';

-- Limite de visibilité assumée, à documenter côté produit : la politique RLS
-- de `staff_impersonation_claims` (0029) n'ouvre la lecture qu'à la ligne dont
-- le condensat du code one-shot est posé en session. Un admin de tenant lisant
-- `audit_log` ne verra donc AUCUNE ligne `staff_impersonation` ; seul le staff
-- les voit, via la fonction ci-dessous. Ouvrir cette source aux admins du
-- tenant est une décision distincte (elle rendrait la ligne, condensat inclus,
-- visible au rôle `openedbot_api` sous `app.organization_id`), qui appartient à la
-- migration propriétaire de cette table, pas à celle-ci.

grant select on audit_log to openedbot_api;

-- Le backoffice staff lit le journal tous tenants confondus. Le préambule de
-- garde est celui de `staff_operational_metrics()` (0023_staff.sql), mot pour
-- mot, y compris l'exception sur un `app.staff_user_id` illisible.
create or replace function staff_audit_log(
  p_limit int default 200,
  p_before timestamptz default null
)
returns table (
  occurred_at timestamptz,
  organization_id uuid,
  source text,
  action text,
  actor_kind text,
  actor_id uuid,
  subject_kind text,
  subject_id uuid,
  details jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  staff_id uuid;
begin
  begin
    staff_id := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  exception
    when invalid_text_representation then
      staff_id := null;
  end;
  if staff_id is null then
    raise exception 'staff authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff_users su where su.id = staff_id and su.disabled_at is null
  ) then
    raise exception 'staff user disabled' using errcode = '42501';
  end if;

  return query
    select
      a.occurred_at,
      a.organization_id,
      a.source,
      a.action,
      a.actor_kind,
      a.actor_id,
      a.subject_kind,
      a.subject_id,
      a.details
      from public.audit_log a
     where p_before is null or a.occurred_at < p_before
     order by a.occurred_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end;
$$;

comment on function staff_audit_log(int, timestamptz) is
  'Journal d''audit unifié servi au backoffice staff, les plus récents d''abord. Pagination par curseur temporel : `p_before` reprend le `occurred_at` de la dernière ligne rendue. `p_limit` est borné à 1000.';

revoke all on function staff_audit_log(int, timestamptz) from public;
grant execute on function staff_audit_log(int, timestamptz) to openedbot_api;

insert into schema_migrations(version) values ('0035_audit_log')
on conflict (version) do nothing;

commit;
