-- Baseline 1 of 10: the migration registry, and the bridge from the history
-- it replaced. Files 0002 to 0010 hold the schema that migrations 0001 to 0192
-- produced (core 0.1.4); new migrations continue at 0193.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- A database migrated by the former files (production, preprod, a development
-- database) already holds this schema: the baseline is recorded, not run. Its
-- runner reads schema_migrations again before the next file. A database
-- stopped before 0192 cannot take the baseline: migrate it with core 0.1.4
-- first, the last release that ships the former files.
DO $$
BEGIN
  IF EXISTS (SELECT FROM schema_migrations WHERE version = '0192_retire_mobile_push') THEN
    INSERT INTO schema_migrations(version) VALUES
      ('0002_functions'), ('0003_tables'), ('0004_constraints'), ('0005_indexes'),
      ('0006_triggers'), ('0007_foreign_keys'), ('0008_row_level_security'),
      ('0009_grants'), ('0010_reference_data')
    ON CONFLICT DO NOTHING;
  ELSIF EXISTS (SELECT FROM schema_migrations WHERE version = '0001_tenancy_auth') THEN
    RAISE EXCEPTION 'this database stopped before migration 0192_retire_mobile_push: migrate it with core 0.1.4 first, then with this baseline';
  END IF;
END
$$;

INSERT INTO schema_migrations(version) VALUES ('0001_schema_migrations') ON CONFLICT DO NOTHING;

COMMIT;
