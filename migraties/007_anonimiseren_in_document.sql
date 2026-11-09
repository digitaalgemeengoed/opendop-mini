-- opendop-mini, migratie 007: anonimiseren in het document.
--
-- De medewerker ziet de plaatshouders al tijdens de voorvertoning in het
-- document. Die gegevens staan dan al versleuteld in het register, als
-- voorvertoning: zo houden ze hun nummer en kan een sessie verder na een
-- crash. Een voorvertoning die de medewerker laat staan, mag weer weg.
-- Bevestigen maakt ze definitief en legt een nieuwe versie vast.
--
-- Per versie: hoe ze ontstond (gewoon, anonimisering, terugzetting), van
-- welke versie, welk PPL-niveau nodig is om haar te lezen, en of ze alleen
-- nog voor informatiebeheer is. Dat vervangt objecten.pii_tot_versie.

ALTER TABLE pii_register ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'bevestigd'
  CHECK (status IN ('voorvertoning', 'bevestigd'));
GRANT UPDATE (status) ON pii_register TO oa_app;
GRANT DELETE ON pii_register TO oa_app;
DROP POLICY IF EXISTS alleen_voorvertoning_weg ON pii_register;
CREATE POLICY alleen_voorvertoning_weg ON pii_register AS RESTRICTIVE FOR DELETE
  USING (status = 'voorvertoning');

ALTER TABLE versies ADD COLUMN IF NOT EXISTS soort text NOT NULL DEFAULT 'gewoon'
  CHECK (soort IN ('gewoon', 'anonimisering', 'terugzetting'));
ALTER TABLE versies ADD COLUMN IF NOT EXISTS bronversie integer;
ALTER TABLE versies ADD COLUMN IF NOT EXISTS ppl smallint NOT NULL DEFAULT 0 CHECK (ppl BETWEEN 0 AND 3);
ALTER TABLE versies ADD COLUMN IF NOT EXISTS beperkt boolean NOT NULL DEFAULT false;

-- Het niveau voor de volgende versies: na terugzetten staan er weer gegevens in het werkdocument.
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS ppl_werk smallint NOT NULL DEFAULT 0 CHECK (ppl_werk BETWEEN 0 AND 3);

-- Wat migratie 006 bijhield, overnemen.
UPDATE versies v SET ppl = 3
  FROM objecten o
 WHERE o.identificatie = v.object AND o.pii_tot_versie IS NOT NULL AND v.nummer <= o.pii_tot_versie AND v.ppl < 3;
