# Wijzigingen

## 0.6.0 — 2026-11-09

**Register van persoonsgegevens** (migratie 006, draait vanzelf). Elk persoonsgegeven dat de medewerker bij anonimiseren bevestigt, staat versleuteld in `pii_register`, met een eigen sleutel per document per AVG-categorie (`pii_sleutels`):

- c1, gewone persoonsgegevens (art. 6): AES-256-GCM;
- c2, bijzondere persoonsgegevens (art. 9): ChaCha20-Poly1305;
- c3, strafrechtelijke gegevens (art. 10): RSA-OAEP met een eigen sleutelpaar (certificaat) per document; de privésleutel staat versleuteld.

De datasleutels zijn verpakt door het sleutelbeheer (OpenBao transit, sleutel `oa-<gemeente>-<object>-pii-cN`). Dezelfde waarde krijgt dezelfde plaatshouder (`[PERSOON 1]`), via een HMAC-zoeksleutel.

- `POST /objecten/:id/pii` registreert en geeft de plaatshouders;
- `GET /objecten/:id/pii` geeft het register zonder waarden;
- `POST /objecten/:id/pii/onthul` geeft waarden, als het niveau van de medewerker (PPL) hoog genoeg is: c1 vraagt PPL 1, c2 PPL 2, c3 PPL 3. Elk inzien is een gebeurtenis;
- `POST /objecten/:id/pii/vernietig` (beheerder) vernietigt de sleutel van een categorie: die waarden zijn daarna onleesbaar (crypto-shredding).

Versies van vóór het anonimiseren bevatten de gegevens nog leesbaar; die geeft het platform alleen aan PPL 3. Vraagt `SLEUTELBEHEER` (lokaal of openbao).

## 0.5.0 — 2026-11-09

Migratie 005: **geanonimiseerde weergaven**. `POST /objecten/:id/versies/:n/anonimisering` legt de door de medewerker bevestigde, geanonimiseerde html vast als weergave bij die versie (soort `geanonimiseerd`, versleuteld zoals de versie, in de bucket van het stuk). Een correctie krijgt een hoger volgnummer; ongewijzigd levert niets nieuws op. De gebeurtenis `anonimisering.vastgelegd` bevat alleen de aantallen per soort, nooit de gegevens. Lezen: `GET …/weergaven/html?soort=geanonimiseerd` (de laatste). Het origineel, de gewone weergave en de zoekindex blijven ongewijzigd. Tests: `test/anonimisering.test.js`.

## 0.4.0 — 2026-11-09

Migratie 004: **zakelijk of persoonlijk**.

- `POST /objecten` kent `aard` (standaard zakelijk). Een persoonlijk stuk heeft geen metadata (409 `persoonlijk-geen-metadata`), staat in een eigen bucket per gemeente (`<voorvoegsel><gemeente>-persoonlijk`, zonder Object Lock), komt niet in de zoekindex en is alleen zichtbaar voor wie het vastlegde; voor anderen bestaat het niet (404).
- `PUT /objecten/:id/aard`: persoonlijk naar zakelijk kan altijd. Versies en weergaven komen als kopie in de bucket van de gemeente; de registratie wijst daarna daarheen; gebeurtenis `aard.gewijzigd`; daarna in de zoekindex. Zakelijk naar persoonlijk kan nog niet (409); dat volgt met de bedenktijd en het verzoek bij de informatiebeheerder. De persoonlijke kopie blijft in het prototype staan.
- Elke aanroep op één object toetst eerst de toegang (`toetsToegang`).
- Tests: `test/persoonlijk.test.js`.

## 0.3.0 — 2026-11-08

Migratie 003: een versie is het origineel (docx, odt …); de html gaat mee als **weergave** (tabel `weergaven`, versleuteld zoals de versie). "Ongewijzigd" wordt bepaald op de weergave, omdat een docx of odt bij elke export anders is. `GET /objecten/:id/versies/:n/weergaven/:formaat`. De zoekindex leest de html-weergave.

## 0.2.0 — 2026-11-07

Fase 1b. Versleuteling per object met OpenBao en onleesbaar maken door de sleutel te vernietigen (OA-ADR-008). Zoeken met OpenSearch, één index per gemeente, met bevestiging van elk resultaat in het register (OA-ADR-007). Beide optioneel. De worker indexeert na elke vastlegging.

## 0.1.1 — 2026-11-07

S3-opslag in de uitrol is SILO, de open-source voortzetting van MinIO (OA-ADR-006).

## 0.1.0 — 2026-11-07

Fase 1 van het werkende prototype: contract, minimaal platform, integratielaag met twee ingangen, assistentkern, paneel en een demo-werkomgeving met de modules metadateren en toegankelijkheid.
