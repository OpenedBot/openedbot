-- Baseline 10 of 10: the rows a fresh database needs.
BEGIN;

INSERT INTO product_features (feature_key, audience, dev, prod) VALUES ('connector_only_enrollment', 'all', true, true);

INSERT INTO schema_migrations(version) VALUES ('0010_reference_data') ON CONFLICT DO NOTHING;

COMMIT;
