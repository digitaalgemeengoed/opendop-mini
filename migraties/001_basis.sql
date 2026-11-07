-- opendop-mini, migratie 001: event store, leesmodellen, outbox en scheiding per gemeente.
--
-- Wordt uitgevoerd met de beheerverbinding (eigenaar van het schema).
-- De applicatie verbindt als rol oa_app; voor die rol geldt Row Level
-- Security, zodat de scheiding tussen gemeenten in de database wordt
-- afgedwongen en niet alleen in de code.

CREATE TABLE IF NOT EXISTS gemeenten (
  id    text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,40}$'),
  naam  text NOT NULL
);

-- Objecttypen met versies. gemeente = '*' is een gedeeld standaardtype.
CREATE TABLE IF NOT EXISTS objecttypen (
  gemeente      text NOT NULL,
  naam          text NOT NULL,
  versie        integer NOT NULL CHECK (versie > 0),
  titel         text NOT NULL,
  schema        jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('concept', 'actief', 'uitgefaseerd')),
  vervaldatum   date,
  gepubliceerd  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gemeente, naam, versie)
);

-- De event store: alleen toevoegen.
CREATE TABLE IF NOT EXISTS gebeurtenissen (
  volgnummer  bigserial PRIMARY KEY,
  id          uuid NOT NULL UNIQUE,
  type        text NOT NULL,
  gemeente    text NOT NULL REFERENCES gemeenten (id),
  object_id   uuid,
  actor       jsonb NOT NULL,
  tijdstip    timestamptz NOT NULL DEFAULT now(),
  gegevens    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS gebeurtenissen_object ON gebeurtenissen (object_id, volgnummer);

CREATE OR REPLACE FUNCTION gebeurtenissen_alleen_toevoegen() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gebeurtenissen worden alleen toegevoegd, nooit gewijzigd of verwijderd';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gebeurtenissen_onveranderlijk ON gebeurtenissen;
CREATE TRIGGER gebeurtenissen_onveranderlijk
  BEFORE UPDATE OR DELETE ON gebeurtenissen
  FOR EACH ROW EXECUTE FUNCTION gebeurtenissen_alleen_toevoegen();

-- Leesmodel: de huidige stand van elk informatieobject.
CREATE TABLE IF NOT EXISTS objecten (
  identificatie      uuid PRIMARY KEY,
  gemeente           text NOT NULL REFERENCES gemeenten (id),
  objecttype_naam    text NOT NULL,
  objecttype_versie  integer NOT NULL,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  laatste_volgnummer bigint NOT NULL,
  aangemaakt         timestamptz NOT NULL,
  aangemaakt_door    text NOT NULL
);

CREATE TABLE IF NOT EXISTS versies (
  object        uuid NOT NULL REFERENCES objecten (identificatie),
  gemeente      text NOT NULL REFERENCES gemeenten (id),
  nummer        integer NOT NULL,
  sha256        text NOT NULL,
  grootte       bigint NOT NULL,
  media_type    text NOT NULL,
  formaat       text NOT NULL,
  opslagsleutel text NOT NULL,
  vastgelegd    timestamptz NOT NULL,
  door          text NOT NULL,
  PRIMARY KEY (object, nummer)
);

-- Outbox: zwaar werk dat na de transactie door de worker wordt gedaan.
CREATE TABLE IF NOT EXISTS outbox (
  id             bigserial PRIMARY KEY,
  gemeente       text NOT NULL REFERENCES gemeenten (id),
  volgnummer     bigint NOT NULL REFERENCES gebeurtenissen (volgnummer),
  taak           text NOT NULL,
  status         text NOT NULL DEFAULT 'wachtend' CHECK (status IN ('wachtend', 'klaar', 'mislukt')),
  pogingen       integer NOT NULL DEFAULT 0,
  laatste_fout   text,
  aangemaakt     timestamptz NOT NULL DEFAULT now(),
  verwerkt       timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_wachtend ON outbox (id) WHERE status = 'wachtend';

-- Rol van de applicatie, zonder eigenaarschap: Row Level Security geldt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oa_app') THEN
    CREATE ROLE oa_app LOGIN;
  END IF;
END
$$;

GRANT SELECT ON gemeenten TO oa_app;
GRANT SELECT, INSERT ON objecttypen, gebeurtenissen, outbox TO oa_app;
GRANT SELECT, INSERT, UPDATE ON objecten, versies TO oa_app;
GRANT USAGE ON SEQUENCE gebeurtenissen_volgnummer_seq, outbox_id_seq TO oa_app;

ALTER TABLE objecttypen    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gebeurtenissen ENABLE ROW LEVEL SECURITY;
ALTER TABLE objecten       ENABLE ROW LEVEL SECURITY;
ALTER TABLE versies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS per_gemeente ON objecttypen;
CREATE POLICY per_gemeente ON objecttypen
  USING (gemeente = '*' OR gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));

DROP POLICY IF EXISTS per_gemeente ON gebeurtenissen;
CREATE POLICY per_gemeente ON gebeurtenissen
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));

DROP POLICY IF EXISTS per_gemeente ON objecten;
CREATE POLICY per_gemeente ON objecten
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));

DROP POLICY IF EXISTS per_gemeente ON versies;
CREATE POLICY per_gemeente ON versies
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));

DROP POLICY IF EXISTS per_gemeente ON outbox;
CREATE POLICY per_gemeente ON outbox
  USING (gemeente = current_setting('oa.gemeente', true))
  WITH CHECK (gemeente = current_setting('oa.gemeente', true));
