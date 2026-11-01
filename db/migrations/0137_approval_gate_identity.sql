begin;

-- PERM2-A (DEV-OHB-250): the identity of a Hermes gate, read by the worker on
-- the raw `approval.request` event (`modules/execution/src/domain/gate-identity.ts`).
-- `hermes_request_id` is the gate Hermes resolves when the answer carries it,
-- instead of the oldest pending one. `gate_kind` says what the gate is; a row
-- written before 0137, or by a worker that does not read the identity, stays
-- `unknown`, which the permission pipeline sends to a human. `tool_key`,
-- `gate_args` and `descriptor_version` exist only for a gate the host plugin
-- described and the worker proved by its digest.
alter table approval_requests
  add column hermes_request_id text null
    constraint approval_requests_hermes_request_id_check
      check (hermes_request_id is null or (length(hermes_request_id) between 1 and 256 and hermes_request_id = btrim(hermes_request_id))),
  add column gate_kind text not null default 'unknown'
    constraint approval_requests_gate_kind_check
      check (gate_kind in ('plugin_tool', 'terminal_danger', 'unknown')),
  add column tool_key text null
    constraint approval_requests_tool_key_check
      check (tool_key is null or tool_key ~ '^([a-z][a-z0-9_]{0,63}|mcp:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,128})$'),
  add column gate_args jsonb null
    constraint approval_requests_gate_args_check
      check (gate_args is null or (jsonb_typeof(gate_args) = 'object' and octet_length(gate_args::text) <= 8192)),
  add column descriptor_version smallint null
    constraint approval_requests_descriptor_version_check
      check (descriptor_version is null or descriptor_version >= 1);

-- A tool key and a descriptor version only describe a plugin gate; a plugin
-- gate always has both.
alter table approval_requests
  add constraint approval_requests_gate_identity_shape_check
    check (
      (gate_kind = 'plugin_tool' and tool_key is not null and descriptor_version is not null and gate_args is not null)
      or (gate_kind = 'terminal_danger' and tool_key is null and descriptor_version is null and gate_args is not null)
      or (gate_kind = 'unknown' and tool_key is null and descriptor_version is null and gate_args is null)
    );

insert into schema_migrations(version) values ('0137_approval_gate_identity');
commit;
