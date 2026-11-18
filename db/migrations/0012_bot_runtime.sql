BEGIN;

ALTER TABLE public.runtimes
    ADD COLUMN dedicated boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT runtimes_dedicated_connector_check CHECK (
        NOT dedicated OR (reachability = 'connector' AND NOT is_active)
    );
-- A dedicated (machine) ticket pairs every agent CLI of one machine during its
-- lifetime: each local engine takes one place, once (`claimed_engines`).
ALTER TABLE public.runtime_enrollments
    ADD COLUMN dedicated boolean NOT NULL DEFAULT false,
    ADD COLUMN claimed_engines text[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT runtime_enrollments_claimed_engines_check CHECK (
        (dedicated OR cardinality(claimed_engines) = 0) AND cardinality(claimed_engines) <= 8
    );

ALTER TABLE public.bots
    ADD COLUMN runtime_id uuid,
    ADD CONSTRAINT bots_runtime_fkey FOREIGN KEY (organization_id, runtime_id)
        REFERENCES public.runtimes (organization_id, id);

CREATE INDEX bots_runtime_idx ON public.bots (organization_id, runtime_id)
    WHERE runtime_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('0012_bot_runtime') ON CONFLICT DO NOTHING;

COMMIT;
