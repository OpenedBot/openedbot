begin;

-- Curseur de la passe d'extraction mémoire : la passe ne relit que les tours
-- postérieurs au dernier qu'elle a couvert. Mesuré le 05-09 : sans curseur,
-- un « Hello » relançait l'extraction sur les douze derniers messages du
-- fil et reproposait deux faits déjà retenus.

alter table threads
  add column memory_extract_cursor_at timestamptz;

insert into schema_migrations(version) values ('0048_memory_extract_cursor')
on conflict (version) do nothing;

commit;
