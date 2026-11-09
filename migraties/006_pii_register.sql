-- opendop-mini, migratie 006: register van persoonsgegevens (anonimiseren bij de bron).
--
-- Na bevestiging staan in het document plaatshouders, zoals [PERSOON 1]. De
-- echte waarde staat hier, versleuteld met een sleutel per document per
-- AVG-categorie:
--   c1  gewone persoonsgegevens (art. 6)        AES-256-GCM
--   c2  bijzondere persoonsgegevens (art. 9)    ChaCha20-Poly1305
--   c3  strafrechtelijke gegevens (art. 10)     RSA-OAEP met een certificaat:
--       versleutelen kan met het publieke deel, ontsleutelen alleen met de
--       privésleutel, die zelf versleuteld is bewaard.
-- De datasleutels zijn verpakt door het sleutelbeheer (OpenBao); vernietigen
-- daar maakt de waarden van die categorie onleesbaar. Register en sleutels
-- staan in dezelfde database als de metadata; alleen toevoegen, nooit wijzigen.

CREATE TABLE IF NOT EXISTS pii_sleutels (
  object      uuid NOT NULL,
  gemeente    text NOT NULL REFERENCES gemeenten (id),
  categorie   text NOT NULL CHECK (categorie IN ('c1', 'c2', 'c3')),
  algoritme   text NOT NULL,
  verpakt     text NOT NULL,
  publiek     text,           -- c3: het certificaat (publieke sleutel, PEM)
  prive       text,           -- c3: de privésleutel, versleuteld met de datasleutel
  aangemaakt  timestamptz NOT NULL DEFAULT now(),
  vernietigd  timestamptz,
  PRIMARY KEY (object, categorie)
);

CREATE TABLE IF NOT EXISTS pii_register (
  object       uuid NOT NULL,
  gemeente     text NOT NULL REFERENCES gemeenten (id),
  plaatshouder text NOT NULL,
  soort        text NOT NULL,
  categorie    text NOT NULL CHECK (categorie IN ('c1', 'c2', 'c3')),
  algoritme    text NOT NULL,
  cijfertekst  text NOT NULL,
  -- Om dezelfde waarde in een volgende ronde dezelfde plaatshouder te geven,
  -- zonder te ontsleutelen: HMAC met de c1-sleutel van het document.
  zoeksleutel  text NOT NULL,
  bron         text NOT NULL,
  versie       integer NOT NULL,
  vastgelegd   timestamptz NOT NULL,
  door         text NOT NULL,
  PRIMARY KEY (object, plaatshouder),
  UNIQUE (object, soort, zoeksleutel)
);

-- Versies tot en met dit nummer bevatten de gegevens nog leesbaar.
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS pii_tot_versie integer;

GRANT SELECT, INSERT ON pii_sleutels, pii_register TO oa_app;
GRANT UPDATE (vernietigd) ON pii_sleutels TO oa_app;
ALTER TABLE pii_sleutels ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_register ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON pii_sleutels;
CREATE POLICY per_gemeente ON pii_sleutels
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
DROP POLICY IF EXISTS per_gemeente ON pii_register;
CREATE POLICY per_gemeente ON pii_register
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
