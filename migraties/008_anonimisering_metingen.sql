-- Kwaliteit van het anonimiseren: per bevestiging een meting, zonder
-- persoonsgegevens en zonder koppeling met het stuk. Alleen de dag, niet het
-- tijdstip, zodat een meting niet aan een gebeurtenis is te koppelen.
CREATE TABLE IF NOT EXISTS anonimisering_metingen (
  id        bigserial PRIMARY KEY,
  gemeente  text NOT NULL REFERENCES gemeenten (id),
  dag       date NOT NULL DEFAULT current_date,
  motor     text,
  items     jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array')
);
CREATE INDEX IF NOT EXISTS anonimisering_metingen_dag ON anonimisering_metingen (gemeente, dag);

GRANT SELECT, INSERT ON anonimisering_metingen TO oa_app;
GRANT USAGE ON SEQUENCE anonimisering_metingen_id_seq TO oa_app;
ALTER TABLE anonimisering_metingen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON anonimisering_metingen;
CREATE POLICY per_gemeente ON anonimisering_metingen
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
