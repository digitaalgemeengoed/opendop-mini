-- Classificeren en bewaren, vergrendelen en wijzigingsvoorstellen.

-- Het classificatiemodel per gemeente, met versies (zoals het metadatamodel).
CREATE TABLE IF NOT EXISTS classificatiemodellen (
  gemeente     text NOT NULL REFERENCES gemeenten (id),
  versie       integer NOT NULL,
  config       jsonb NOT NULL,
  gepubliceerd timestamptz NOT NULL DEFAULT now(),
  door         text,
  PRIMARY KEY (gemeente, versie)
);
GRANT SELECT, INSERT ON classificatiemodellen TO oa_app;
ALTER TABLE classificatiemodellen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON classificatiemodellen;
CREATE POLICY per_gemeente ON classificatiemodellen
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));

-- Per stuk: de classificatie, en per status de dag waarop het stuk die
-- status voor het eerst kreeg (daar gaat de bewaartermijn op in).
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS classificatie jsonb;
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS statusdata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Een wijziging aan een vergrendeld stuk: naast het stuk, niet in de
-- versieketen. Pas na goedkeuring door een vrijgever wordt het een versie.
CREATE TABLE IF NOT EXISTS wijzigingsvoorstellen (
  id                 uuid PRIMARY KEY,
  gemeente           text NOT NULL REFERENCES gemeenten (id),
  object             uuid NOT NULL REFERENCES objecten (identificatie),
  bronversie         integer NOT NULL,
  reden              text NOT NULL,
  door               jsonb NOT NULL,
  ingediend          timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'goedgekeurd', 'afgewezen')),
  formaat            text NOT NULL,
  media_type         text NOT NULL,
  opslagsleutel      text NOT NULL,
  w_formaat          text,
  w_media_type       text,
  w_opslagsleutel    text,
  versleuteld        boolean NOT NULL,
  ruimte             text NOT NULL,
  beoordeeld_door    jsonb,
  beoordeeld_op      timestamptz,
  toelichting        text,
  versie             integer
);
CREATE INDEX IF NOT EXISTS wijzigingsvoorstellen_open ON wijzigingsvoorstellen (gemeente, status, ingediend);
CREATE INDEX IF NOT EXISTS wijzigingsvoorstellen_object ON wijzigingsvoorstellen (object);
GRANT SELECT, INSERT ON wijzigingsvoorstellen TO oa_app;
GRANT UPDATE (status, beoordeeld_door, beoordeeld_op, toelichting, versie) ON wijzigingsvoorstellen TO oa_app;
ALTER TABLE wijzigingsvoorstellen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS per_gemeente ON wijzigingsvoorstellen;
CREATE POLICY per_gemeente ON wijzigingsvoorstellen
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
