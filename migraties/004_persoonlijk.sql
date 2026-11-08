-- opendop-mini, migratie 004: zakelijk of persoonlijk.
--
-- Een zakelijk stuk is een archiefstuk: metadata volgens het objecttype,
-- opslag in de bucket van de gemeente (Object Lock), in de zoekindex.
-- Een persoonlijk stuk valt daarbuiten: geen metadata, een eigen bucket
-- zonder Object Lock, niet in de zoekindex, en alleen zichtbaar voor wie het
-- heeft vastgelegd. Persoonlijk naar zakelijk kan altijd; andersom (binnen
-- de bedenktijd, of op verzoek bij de informatiebeheerder) volgt.

ALTER TABLE objecten ADD COLUMN IF NOT EXISTS aard text NOT NULL DEFAULT 'zakelijk';
DO $$ BEGIN
  ALTER TABLE objecten ADD CONSTRAINT objecten_aard CHECK (aard IN ('zakelijk', 'persoonlijk'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- In welke bucket een versie of weergave staat. Na "zakelijk maken" staat er
-- een kopie in de bucket van de gemeente en wijst de registratie daarheen.
ALTER TABLE versies ADD COLUMN IF NOT EXISTS ruimte text NOT NULL DEFAULT 'zakelijk';
ALTER TABLE weergaven ADD COLUMN IF NOT EXISTS ruimte text NOT NULL DEFAULT 'zakelijk';
GRANT UPDATE (ruimte) ON weergaven TO oa_app;
