# opendop-mini

Een **minimaal platform** voor het prototype van de Office Assistent: een kleine Object Service op PostgreSQL en S3-opslag. Niet de opslag van de assistent; de assistent heeft geen eigen opslag (OA-ADR-002).

> Een prototype, geen product. Later te vervangen door OpenDOP of de Nextcloud-stack, zonder dat paneel, kern of adapters iets merken.

## Wat het doet

- **Informatieobjecten** met een identificatie die het platform toekent, los van de plek van het bestand.
- **Metadata** getoetst tegen een geversioneerd objecttype (JSON Schema). Een object mag onvolledig zijn; wat er staat moet kloppen. Een object houdt de versie van het objecttype waaronder het is vastgelegd.
- **Versies**: elke nieuwe inhoud een nieuwe versie onder een sleutel die nooit wordt hergebruikt; ongewijzigde inhoud levert geen versie op. Bij het lezen wordt de sha-256 gecontroleerd.
- **Origineel en weergaven**: de versie is het bestand zoals de werkomgeving het bewaart (docx, odt …). De html waarmee de assistent werkt, gaat mee als weergave (MDTO: een representatie), versleuteld zoals de versie: `GET /objecten/:id/versies/:n/weergaven/html`. Of een versie ongewijzigd is, bepaalt het platform op de weergave, omdat een docx of odt bij elke export anders is. De zoekindex leest de html-weergave.
- **Event store**: elke vastlegging is een gebeurtenis in een tabel die alleen toevoegen toestaat (afgedwongen met een trigger).
- **Scheiding per gemeente** met Row Level Security in PostgreSQL. De applicatie verbindt als rol `oa_app`; zonder gemeente-instelling ziet zij geen enkele rij.
- **Outbox** voor zwaar werk na de transactie, verwerkt door een worker (OA-ADR-003). In fase 1 alleen een lege taak `zoekindex`.
- **Zakelijk of persoonlijk** (migratie 004): een persoonlijk stuk heeft geen metadata, staat in een eigen bucket zonder Object Lock (`…-persoonlijk`), komt niet in de zoekindex en is alleen zichtbaar voor wie het vastlegde (voor anderen: 404). `PUT /objecten/:id/aard` maakt het zakelijk: kopie in het archief, dan in de index. Andersom kan nog niet; dat volgt met de bedenktijd.
- **Register van persoonsgegevens** (migratie 006): bij anonimiseren bij de bron staat elk bevestigd persoonsgegeven versleuteld in `pii_register`, met een sleutel per document per AVG-categorie (art. 6 AES-256-GCM, art. 9 ChaCha20-Poly1305, art. 10 RSA-OAEP met een eigen sleutelpaar). Inzien hangt af van het PPL-niveau van de medewerker en is een gebeurtenis; een beheerder kan de sleutel van een categorie vernietigen. Vraagt sleutelbeheer.
- **Geanonimiseerde weergaven** (migratie 005, eerste ronde; het paneel gebruikt nu het register): de html met persoonsgegevens afgeschermd, door een medewerker bevestigd, als weergave bij een versie (`POST /objecten/:id/versies/:n/anonimisering`). Het origineel blijft; correcties krijgen een volgnummer; de gebeurtenis bevat alleen aantallen.
- **Gelijktijdig werken**: wie vastlegt met `verwachteVolgnummer` krijgt 409 als het object intussen is gewijzigd.

Alleen de integratielaag mag het platform aanroepen (gedeelde dienstsleutel; in productie mTLS). De gemeente en de actor komen van de integratielaag.

## Opslag

`OPSLAG=s3` schrijft naar S3 met één bucket per gemeente, aangemaakt met versiebeheer en **Object Lock**: dat kan alleen bij het aanmaken van een bucket (OA-ADR-005). Bewaartermijnen, legal hold en bestuurde verwijdering zijn in het prototype nog gesimuleerd. `OPSLAG=lokaal` schrijft naar schijf, voor ontwikkeling en tests.

In de uitrol is de S3-opslag SILO, de open-source voortzetting van MinIO (OA-ADR-006). De code gebruikt alleen de S3-API; elke S3-opslag met Object Lock werkt.

## Versleuteling per object (OA-ADR-008)

Met `SLEUTELBEHEER=openbao` krijgt elk nieuw object een eigen sleutel in de transit-engine van OpenBao (`transit/keys/oa-<gemeente>-<object>`). De inhoud wordt met AES-256-GCM versleuteld voordat zij de opslag in gaat; het platform bewaart alleen de verpakte datasleutel. Elke versie is aan object en versienummer gebonden.

**Onleesbaar maken** (`POST /objecten/:id/onleesbaar`, met een reden van minstens tien tekens; in de integratielaag alleen voor de rol beheerder) vernietigt de sleutel. Alle versies zijn daarna onleesbaar, ook in back-ups van database en opslag. De registratie en de gebeurtenissen blijven, met de gebeurtenis `object.onleesbaar-gemaakt` en de reden. Dit werkt samen met Object Lock: de opslag weigert verwijderen, de sleutel maakt de inhoud toch onbruikbaar.

Let op: snapshots van OpenBao bevatten de sleutels nog. Begrens hun bewaartermijn, anders is vernietigen niet definitief. Het platform vernieuwt zijn periodieke token zelf (bij het starten en elke twaalf uur).

`SLEUTELBEHEER=lokaal` doet hetzelfde met sleutels op schijf, voor ontwikkeling en tests. `uit` versleutelt niet; bestaande versleutelde objecten zijn dan niet te lezen.

## Zoeken (OA-ADR-007)

Met `ZOEKINDEX=opensearch` zet de worker na elke vastlegging de huidige stand van het object in de index van de gemeente (`oa-<gemeente>`): metadata en de tekst van de laatste versie. `GET /zoeken?tekst=…` zoekt in die index en **bevestigt elk resultaat in het register**, met Row Level Security; de metadata in het antwoord komt uit het register en filters worden ook daar toegepast. Treffers die het register niet bevestigt, worden alleen geteld (`nietBevestigd`). Onleesbaar gemaakte objecten gaan uit de index.

De index bevat leesbare tekst, ook van versleutelde stukken. Bescherm hem even goed als de opslag. Met `ZOEKINDEX=uit` geeft zoeken 503.

## Gebruik

| Opdracht | Wat |
|---|---|
| `npm run migreer` | Migraties en startgegevens (gemeenten uit `GEMEENTEN`, objecttype `document`) |
| `npm start` | De Object Service op poort 4100 |
| `npm run worker` | De outbox-worker |

Omgevingsvariabelen staan in `src/config.ts`. De worker heeft dezelfde instellingen voor opslag, sleutelbeheer en zoekindex nodig als de server.

## Testen

De integratietests draaien tegen een echte, lege PostgreSQL, en voor fase 1b tegen nabootsingen van de transit-API van OpenBao en van de zoek-API van OpenSearch (met de echte OpenSearch-client):

```
npm run build
TEST_DATABASE_URL_BEHEER=postgresql://beheer@localhost/oa_test \
TEST_DATABASE_URL=postgresql://oa_app@localhost/oa_test npm test
```

## Licentie

© 2026 Gemeente Haarlem. EUPL 1.2, zie `LICENSE`.

Gemaakt door Erik Hoekstra, programma-architect en senior consultant, afdeling i-Ontwikkeling, Gemeente Haarlem, met assistentie van Claude (Anthropic).
