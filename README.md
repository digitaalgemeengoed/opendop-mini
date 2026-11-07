# opendop-mini

Een **minimaal platform** voor het prototype van de Office Assistent: een kleine Object Service op PostgreSQL en S3-opslag. Niet de opslag van de assistent; de assistent heeft geen eigen opslag (OA-ADR-002).

> Een prototype, geen product. Later te vervangen door OpenDOP of de Nextcloud-stack, zonder dat paneel, kern of adapters iets merken.

## Wat het doet

- **Informatieobjecten** met een identificatie die het platform toekent, los van de plek van het bestand.
- **Metadata** getoetst tegen een geversioneerd objecttype (JSON Schema). Een object mag onvolledig zijn; wat er staat moet kloppen. Een object houdt de versie van het objecttype waaronder het is vastgelegd.
- **Versies**: elke nieuwe inhoud een nieuwe versie onder een sleutel die nooit wordt hergebruikt; ongewijzigde inhoud levert geen versie op. Bij het lezen wordt de sha-256 gecontroleerd.
- **Event store**: elke vastlegging is een gebeurtenis in een tabel die alleen toevoegen toestaat (afgedwongen met een trigger).
- **Scheiding per gemeente** met Row Level Security in PostgreSQL. De applicatie verbindt als rol `oa_app`; zonder gemeente-instelling ziet zij geen enkele rij.
- **Outbox** voor zwaar werk na de transactie, verwerkt door een worker (OA-ADR-003). In fase 1 alleen een lege taak `zoekindex`.
- **Gelijktijdig werken**: wie vastlegt met `verwachteVolgnummer` krijgt 409 als het object intussen is gewijzigd.

Alleen de integratielaag mag het platform aanroepen (gedeelde dienstsleutel; in productie mTLS). De gemeente en de actor komen van de integratielaag.

## Opslag

`OPSLAG=s3` schrijft naar S3 met één bucket per gemeente, aangemaakt met versiebeheer en **Object Lock**: dat kan alleen bij het aanmaken van een bucket (OA-ADR-005). Bewaartermijnen, legal hold en bestuurde verwijdering zijn in het prototype nog gesimuleerd. `OPSLAG=lokaal` schrijft naar schijf, voor ontwikkeling en tests.

Let op: MinIO publiceert sinds oktober 2025 geen community-images meer. De code gebruikt alleen de S3-API; de keuze van de S3-opslag staat open.

## Gebruik

| Opdracht | Wat |
|---|---|
| `npm run migreer` | Migraties en startgegevens (gemeenten uit `GEMEENTEN`, objecttype `document`) |
| `npm start` | De Object Service op poort 4100 |
| `npm run worker` | De outbox-worker |

Omgevingsvariabelen staan in `src/config.ts`.

## Testen

De integratietest draait tegen een echte, lege PostgreSQL:

```
npm run build
TEST_DATABASE_URL_BEHEER=postgresql://beheer@localhost/oa_test \
TEST_DATABASE_URL=postgresql://oa_app@localhost/oa_test npm test
```

## Licentie

© 2026 Gemeente Haarlem. EUPL 1.2, zie `LICENSE`.

Gemaakt door Erik Hoekstra, programma-architect en senior consultant, afdeling i-Ontwikkeling, Gemeente Haarlem, met assistentie van Claude (Anthropic).
