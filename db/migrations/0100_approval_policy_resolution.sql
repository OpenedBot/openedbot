-- An approval answered by the bot's permission policy (agent editor, 0099)
-- records which policy answered it. The worker keeps no access to the signed
-- `decisions` journal (0080_worker_least_privilege): the policy trace lives on
-- the approval row it already writes, next to `resolved_by` (null here).
begin;

alter table approval_requests
  add column resolved_by_policy text null
    check (resolved_by_policy is null or resolved_by_policy in ('auto', 'bypass')),
  add constraint approval_requests_policy_has_no_user
    check (resolved_by_policy is null or resolved_by is null);

insert into schema_migrations(version) values ('0100_approval_policy_resolution');
commit;
