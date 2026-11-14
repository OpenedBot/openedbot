# Backup and recovery for a self-hosted installation

The Markdown/JSON exports of the console are not a restorable backup. They leave out binary files, secrets and the runtime's state.

## Prepare a consistent backup

1. Record the exact versions of the API, worker, link gateway and desktop app, the applied migrations, and the Hermes and edge-setup versions. Set aside one private encrypted storage for backups and a separate one for keys.
2. During a maintenance window, let running work finish, then stop every writer (API, worker and Hermes routines). Check that no run or deletion is in progress. Do not force a restart of work whose outcome is uncertain.
3. Run `scripts/db-backup.sh --dir <private-directory> --database <database> --restore-check` with the appropriate libpq parameters. The script keeps only one local copy: copy each validated backup to the private storage, with retention, before taking the next one.
4. Copy the attachment storage that matches the dump: the `file` driver's directory, or the R2 bucket's objects with their keys and versions. Do not delete objects after the dump; suspend purges while copying.
5. Back up the Hermes data of each host while its writes are suspended, following the paths of that installation. Include profiles, memory, sessions, working files and local configuration. Copying the binaries alone is not enough.
6. Keep the configuration and the current and previous encryption keys (`RUNTIME_TOKEN_ENCRYPTION_KEY` and its keyring) apart from the data, together with the secrets needed to restart. Never put them in test screenshots or logs.
7. List the files with their SHA-256, date the backup and restart the services. Without a backup of the storage and of the hosts, mark the recovery explicitly as partial.

## Restore into an isolated environment

1. Prepare an empty database and separate volumes or buckets. Refuse to overwrite an existing database or directory. Use the backed-up versions before attempting any upgrade.
2. Keep the API, the worker and the connectors stopped; restore the database with `pg_restore --exit-on-error --no-owner` as the intended schema owner. The application roles must exist before the restore; keep their grants and check the RLS policies. Check the applied migrations and that no error was reported.
3. Restore the storage, the host data with its permissions, and the encryption configuration. In the isolated environment, disable external transports and use a local mail catcher such as Mailpit. Block access to production hosts and to real providers before starting the worker.
4. Start the API, then check sign-in, bots, conversations and downloads. Verify the SHA-256 of a few reference files. Then start the worker and the isolated host's connector.
5. For interrupted work that awaits verification, start with the **reconcile** recovery action. A database restore does not prove that an external action has not already happened.
6. In the isolated environment, check a reference memory on the host, a paused routine, an approval request and a new task. Record the duration, commands, versions and PASS/FAIL/NOT RUN results.

The test `tests/integration/mvp-recovery.ts` checks the PostgreSQL dump/restore and the local reference files. On its own it does not qualify the recovery of a Hermes host, of R2 or of its keys: those need a restore drill on a matching isolated environment.

## E-mail delivery

Events are reserved durably under a unique key and checked again before sending. An SMTP retry after a crash between the server's acceptance and the database acknowledgement can still produce a duplicate: SMTP does not guarantee idempotency. Compatible HTTP transports receive the existing idempotency key. Turning a preference off does not recall an e-mail already handed over.
