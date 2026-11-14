-- A bot can ask for its model's fast mode: the same model, served faster at a
-- higher price (OpenAI and xAI priority processing, Anthropic fast mode).
-- Hermes says which models offer it (`capabilities.<model>.fast` of
-- `/api/model/options`) and takes it per run (`model_options.fast`). The
-- worker sends it only when the run's resolved model is the chosen one and the
-- catalogue marks it fast, so a stored `true` on a model without fast mode,
-- or a fallback to another model, runs at normal speed.
--
-- ADDITIVE: false for every existing bot; the previous release never reads it.
begin;

alter table bots
  add column if not exists fast_mode boolean not null default false;

insert into schema_migrations(version) values ('0181_bot_fast_mode')
on conflict (version) do nothing;
commit;
