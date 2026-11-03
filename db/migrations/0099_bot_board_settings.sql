-- The agent editor (BoardUI template): per-bot label, reply language,
-- finish notification, speech rate and permission mode.
--
-- permission_mode is an OHB policy, not the host's `approvals.mode` (the host
-- keeps `manual`, edge-setup SecurityDefaults): `manual` leaves every approval
-- to the operator, `auto` and `bypass` let the worker answer them for this
-- bot's runs, `plan` asks the bot for a plan before it acts.
begin;

alter table bots
  add column label text null check (label is null or char_length(label) between 1 and 60),
  add column reply_language text not null default 'auto'
    check (reply_language in ('auto', 'en', 'fr', 'es', 'de', 'it', 'pt', 'ja', 'tr')),
  add column notify_on_finish boolean not null default true,
  add column speech_rate numeric(3, 2) not null default 1
    check (speech_rate in (0.75, 1, 1.25, 1.5)),
  add column permission_mode text not null default 'manual'
    check (permission_mode in ('auto', 'manual', 'plan', 'bypass'));

insert into schema_migrations(version) values ('0099_bot_board_settings');
commit;
