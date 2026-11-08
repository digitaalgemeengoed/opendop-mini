-- opendop-mini, migratie 003: het origineel als versie, met weergaven ernaast.
--
-- De versie is het bestand zoals de werkomgeving het bewaart (docx, odt …).
-- Een weergave is dezelfde inhoud in een andere vorm, zoals de html waarmee
-- de assistent werkt (MDTO: een bestand dat een representatie is van een
-- ander). Weergaven worden versleuteld zoals de versie zelf.

CREATE TABLE IF NOT EXISTS weergaven (
  object        uuid NOT NULL,
  gemeente      text NOT NULL REFERENCES gemeenten (id),
  nummer        integer NOT NULL,
  formaat       text NOT NULL,
  media_type    text NOT NULL,
  sha256        text NOT NULL,
  grootte       bigint NOT NULL,
  opslagsleutel text NOT NULL,
  versleuteld   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (object, nummer, formaat),
  FOREIGN KEY (object, nummer) REFERENCES versies (object, nummer)
);

-- Waarmee "ongewijzigd" wordt bepaald. Een docx of odt verschilt bij elke
-- export (tijdstempels in het bestand); de html-weergave niet. Leeg = sha256.
ALTER TABLE versies ADD COLUMN IF NOT EXISTS vergelijk_sha256 text;

GRANT SELECT, INSERT ON weergaven TO oa_app;
ALTER TABLE weergaven ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON weergaven;
CREATE POLICY per_gemeente ON weergaven
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
