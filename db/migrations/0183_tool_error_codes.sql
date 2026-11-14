-- Preserve historical diagnostic text. Older incidents are classified on read;
-- new incidents store a stable code alongside their sanitized technical detail.
begin;

alter table tool_errors
  add column error_code text not null default 'TOOL_EXECUTION_FAILED'
    constraint tool_errors_error_code_check check (error_code in (
      'PYTHON_DEPENDENCY_MISSING', 'APPROVAL_REQUIRED', 'TOOL_EXECUTION_FAILED'
    ));

insert into schema_migrations(version) values ('0183_tool_error_codes')
on conflict (version) do nothing;
commit;
