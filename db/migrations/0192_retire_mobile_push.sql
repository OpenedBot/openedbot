-- Retire transports absent from the public clients. Historical rows remain
-- available to the existing account-erasure functions and backups.
BEGIN;

DROP TRIGGER IF EXISTS workflows_push_notification ON workflows;
DROP FUNCTION IF EXISTS enqueue_push_notification();

INSERT INTO schema_migrations(version) VALUES ('0192_retire_mobile_push') ON CONFLICT DO NOTHING;

COMMIT;
