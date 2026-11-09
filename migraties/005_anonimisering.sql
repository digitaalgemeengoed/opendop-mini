-- opendop-mini, migratie 005: geanonimiseerde weergaven.
--
-- Een medewerker bevestigt welke persoonsgegevens worden afgeschermd; het
-- platform bewaart die geanonimiseerde html als weergave bij de versie
-- (soort 'geanonimiseerd'). Het origineel en de gewone weergave blijven
-- ongewijzigd. Een correctie wordt een nieuwe geanonimiseerde weergave met
-- een hoger volgnummer; eerdere blijven bestaan.

ALTER TABLE weergaven ADD COLUMN IF NOT EXISTS soort text NOT NULL DEFAULT 'weergave';
ALTER TABLE weergaven ADD COLUMN IF NOT EXISTS volgnummer integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE weergaven ADD CONSTRAINT weergaven_soort CHECK (soort IN ('weergave', 'geanonimiseerd'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weergaven_pkey'
             AND array_length(conkey, 1) = 3) THEN
    ALTER TABLE weergaven DROP CONSTRAINT weergaven_pkey;
    ALTER TABLE weergaven ADD PRIMARY KEY (object, nummer, formaat, soort, volgnummer);
  END IF;
END $$;
