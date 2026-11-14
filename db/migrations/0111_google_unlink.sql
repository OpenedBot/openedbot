-- Google SSO linked and unlinked from "My account".
--
-- Until now the Google link was only ever set implicitly: a verified Google
-- sign-in whose e-mail matched an account wrote `google_subject` on it. The
-- account screen now links Google explicitly (an OAuth attempt bound to the
-- signed-in user) and unlinks it when a password remains.
--
-- Unlinking alone would be undone by the next Google sign-in, which links by
-- e-mail. `google_unlinked_at` remembers the operator's choice: while it is
-- set, a Google identity found by e-mail only is refused, and only an explicit
-- link from the account screen clears it.
begin;

alter table users
  add column google_unlinked_at timestamptz;

comment on column users.google_unlinked_at is
  'Set when the user unlinked Google from the account screen: Google sign-in no longer links this account by e-mail until it is linked again explicitly.';

-- A link attempt ends without a session: its own terminal status.
alter table oauth_attempts drop constraint if exists oauth_attempts_status_check;
alter table oauth_attempts add constraint oauth_attempts_status_check
  check (status in ('pending', 'exchanging', 'done_web', 'done_native', 'done_link', 'failed'));

-- Unlinking Google revokes the other sessions, like a password change.
alter table sessions drop constraint if exists sessions_revoked_reason_check;
alter table sessions add constraint sessions_revoked_reason_check
  check (revoked_reason is null
    or revoked_reason in ('logout', 'user_revoked', 'password_change', 'refresh_rotation', 'google_unlink'));

insert into schema_migrations(version) values ('0111_google_unlink')
on conflict (version) do nothing;

commit;
