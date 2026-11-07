-- opendop-mini, migratie 002: versleuteling per object (OA-ADR-008).

ALTER TABLE objecten ADD COLUMN IF NOT EXISTS versleuteld boolean NOT NULL DEFAULT false;
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS sleutel_verpakt text;
ALTER TABLE objecten ADD COLUMN IF NOT EXISTS onleesbaar_gemaakt timestamptz;
ALTER TABLE versies  ADD COLUMN IF NOT EXISTS versleuteld boolean NOT NULL DEFAULT false;

-- Een onleesbaar gemaakt object heeft geen verpakte sleutel meer.
ALTER TABLE objecten DROP CONSTRAINT IF EXISTS onleesbaar_zonder_sleutel;
ALTER TABLE objecten ADD CONSTRAINT onleesbaar_zonder_sleutel
  CHECK (onleesbaar_gemaakt IS NULL OR sleutel_verpakt IS NULL);
