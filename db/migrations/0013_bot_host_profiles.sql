BEGIN;

-- The machines where a bot created its own profile. A bot that comes back to
-- one finds that profile there (a move does not delete it): the worker takes
-- it back instead of calling it foreign (`PROFILE_SLUG_TAKEN`). A profile of
-- the same name that the bot never created stays foreign.
CREATE TABLE public.bot_host_profiles (
    organization_id uuid NOT NULL,
    bot_id uuid NOT NULL,
    runtime_id uuid NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT bot_host_profiles_pkey PRIMARY KEY (organization_id, bot_id, runtime_id, slug),
    CONSTRAINT bot_host_profiles_bot_fkey FOREIGN KEY (organization_id, bot_id)
        REFERENCES public.bots (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT bot_host_profiles_runtime_fkey FOREIGN KEY (organization_id, runtime_id)
        REFERENCES public.runtimes (organization_id, id) ON DELETE CASCADE
);

-- A profile provisioned before this table is recorded on its current machine:
-- the provision that created it there succeeded as ours.
INSERT INTO public.bot_host_profiles (organization_id, bot_id, runtime_id, slug)
SELECT organization_id, bot_id, runtime_id, slug FROM public.bot_profile_provisions
 WHERE status = 'succeeded' AND host_profile_ownership = 'ours'
ON CONFLICT DO NOTHING;

ALTER TABLE public.bot_host_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_host_profiles_tenant ON public.bot_host_profiles TO openedbot_api USING ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)) WITH CHECK ((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid));
CREATE POLICY bot_host_profiles_worker ON public.bot_host_profiles TO openedbot_worker USING (true) WITH CHECK (true);

GRANT SELECT,INSERT ON TABLE public.bot_host_profiles TO openedbot_api;
GRANT SELECT,INSERT,DELETE ON TABLE public.bot_host_profiles TO openedbot_worker;

INSERT INTO schema_migrations(version) VALUES ('0013_bot_host_profiles') ON CONFLICT DO NOTHING;

COMMIT;
