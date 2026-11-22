-- Engine identity belongs to the last admitted connector hello.
BEGIN;

ALTER TABLE public.runtimes
    ADD COLUMN link_engine text,
    ADD COLUMN link_engine_version text,
    ADD CONSTRAINT runtimes_link_engine_name CHECK (link_engine ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
    ADD CONSTRAINT runtimes_link_engine_length CHECK (char_length(link_engine) <= 64),
    ADD CONSTRAINT runtimes_link_engine_version_length CHECK (char_length(link_engine_version) <= 64);

COMMENT ON COLUMN public.runtimes.link_engine IS 'Engine declared in the last admitted hello. NULL when absent, meaning Hermes. At most 64 characters.';
COMMENT ON COLUMN public.runtimes.link_engine_version IS 'Raw engine version declared in the last admitted hello, at most 64 characters. NULL when absent; Hermes hosts fall back to link_hermes_version in the DTO.';

-- Existing table-wide SELECT/INSERT/UPDATE grants cover the new columns.
-- Keep every existing runtime change condition and notify for engine changes.
DROP TRIGGER runtimes_change_notify ON public.runtimes;
CREATE TRIGGER runtimes_change_notify AFTER UPDATE ON public.runtimes
FOR EACH ROW WHEN (
    old.name IS DISTINCT FROM new.name
    OR old.endpoint IS DISTINCT FROM new.endpoint
    OR old.capacity IS DISTINCT FROM new.capacity
    OR old.revoked_at IS DISTINCT FROM new.revoked_at
    OR old.is_active IS DISTINCT FROM new.is_active
    OR old.reachability IS DISTINCT FROM new.reachability
    OR old.last_health_status IS DISTINCT FROM new.last_health_status
    OR old.last_health_error IS DISTINCT FROM new.last_health_error
    OR old.selected_provider IS DISTINCT FROM new.selected_provider
    OR old.selected_model IS DISTINCT FROM new.selected_model
    OR old.reasoning_effort IS DISTINCT FROM new.reasoning_effort
    OR old.link_instance_id IS DISTINCT FROM new.link_instance_id
    OR old.link_connected_at IS DISTINCT FROM new.link_connected_at
    OR old.link_generation IS DISTINCT FROM new.link_generation
    OR old.link_features IS DISTINCT FROM new.link_features
    OR old.link_agent IS DISTINCT FROM new.link_agent
    OR old.link_hermes_version IS DISTINCT FROM new.link_hermes_version
    OR old.link_origin IS DISTINCT FROM new.link_origin
    OR old.link_token_rotated_at IS DISTINCT FROM new.link_token_rotated_at
    OR old.link_engine IS DISTINCT FROM new.link_engine
    OR old.link_engine_version IS DISTINCT FROM new.link_engine_version
    OR (old.edge_auth_ciphertext IS NULL) IS DISTINCT FROM (new.edge_auth_ciphertext IS NULL)
) EXECUTE FUNCTION public.notify_openedbot_runtime();

INSERT INTO schema_migrations(version) VALUES ('0011_runtime_link_engine') ON CONFLICT DO NOTHING;

COMMIT;
