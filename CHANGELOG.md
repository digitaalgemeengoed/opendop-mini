# Wijzigingen

## 0.11.1 — 2026-11-10

Het metadatamodel accepteert `geenCategorie` bij het veld voor de Woo-informatiecategorie (oa-contract 0.8.1).

## 0.11.0 — 2026-11-10

**Classificeren, bewaren, vergrendelen en wijzigingsvoorstellen.**

- Migratie 009: `classificatiemodellen` (versies per gemeente), `objecten.classificatie` en `objecten.statusdata` (per status de dag waarop het stuk die status voor het eerst kreeg), en `wijzigingsvoorstellen` (naast het stuk; de inhoud versleuteld met de sleutel van het stuk). Alles met rijbeveiliging per gemeente.
- `GET /classificatiemodel`, `POST /classificatiemodel/controle`, `POST /classificatiemodel` (publiceren, getoetst tegen de statussen van het metadatamodel); `GET /classificatie` (`?alleenModel=1` zonder de lijst).
- `PUT /objecten/:id/classificatie`: klasse en attributen, getoetst tegen het model.
- **Vergrendeld** (status in `vergrendelBij`): geen nieuwe versie (409 `vergrendeld`), geen andere metadata of classificatie, behalve voor een vrijgever. Een geanonimiseerde versie (voor openbaarmaking) mag wel.
- `POST /objecten/:id/voorstellen`, `GET /voorstellen` (open voorstellen alleen voor een vrijgever), `GET /voorstellen/:id/weergave`, `POST /voorstellen/:id/beoordeling`: goedkeuren maakt een versie op naam van de indiener; niet het eigen voorstel; een voorstel op een verouderde versie wordt geweigerd.

## 0.10.0 — 2026-11-10

- Het metadatamodel kan een naam hebben (`config.naam`, hoogstens 80 tekens); een andere naam is een nieuwe versie van het objecttype.
- `GET /objecttypen/:naam/versies` noemt per versie de `modelnaam`.

## 0.9.0 — 2026-11-09

**Kwaliteit van het anonimiseren.**

- Migratie 008: tabel `anonimisering_metingen` (gemeente, dag, herkenner, items), met rijbeveiliging per gemeente. Geen koppeling met het stuk, geen waarden, alleen de dag.
- `POST /objecten/:id/pii/bevestig` neemt een `meting` aan en bewaart die in dezelfde transactie. Het schema laat geen waarden door: de vorm mag alleen `9`, `A`, `a`, spaties en leestekens bevatten, het signaalwoord moet van de vaste lijst komen.
- `GET /anonimisering/kwaliteit?dagen=90&drempel=5`: precisie en "gevonden" (een bovengrens voor de recall) per soort en per herkenner, zekerheid tegen terecht/onterecht, gewijzigde grondslag, en de vormen die medewerkers zelf toevoegden of lieten staan, met een regexp als begin voor een patroon. Een vorm verschijnt pas als hij in minstens `drempel` bevestigingen voorkwam.

## 0.8.0 — 2026-11-09

**Metadatamodellen per gemeente.**

- `GET /metadatamodellen`: de catalogus (MDTO, RGBZ, TMLO, waardelijsten). `POST /metadatamodellen/controle`: een keuze toetsen en de velden tonen, zonder iets vast te leggen.
- `POST /objecttypen/:naam/model`: een keuze publiceren als nieuwe versie van het objecttype, alleen voor deze gemeente (gebeurtenis `objecttype.gepubliceerd`). Andere gemeenten houden de gedeelde versie; stukken houden de versie waarmee ze zijn vastgelegd.
- `GET /objecttypen/:naam/versies`: de versies, eigen en gedeeld, met wie ze publiceerde en welk model.
- Zoeken en indexeren via de rollen in het schema: een RGBZ-veld *titel* komt in de index als naam, filters op informatiecategorie en vertrouwelijkheid werken ongeacht het model. Zoekresultaten hebben `kern`.

## 0.7.2 — 2026-11-09

**De grondslag van een persoonsgegeven aanpassen.**

- `POST /objecten/:id/pii/categorie` (`plaatshouder`, `categorie`): een voorvertoning in een andere AVG-categorie. De waarde gaat over naar de sleutel van die categorie; de plaatshouder blijft. Je moet het origineel kunnen lezen (het niveau van de oude categorie). Na bevestigen ligt de grondslag vast (409). Gebeurtenis `pii.categorie-gewijzigd` (plaatshouder, van, naar; zonder waarde).
- Registreren kan meteen met een andere categorie (`items[].categorie`).
- Geen nieuwe rechten in de database: wijzigen is weghalen en opnieuw toevoegen in één transactie, binnen de regels van migratie 007.

## 0.7.1 — 2026-11-09

`/gezondheid` noemt de versie van het platform (voor de overzichtspagina).

## 0.7.0 — 2026-11-09

**Anonimiseren in het document** (migratie 007, draait vanzelf).

- Registreren als voorvertoning (`voorvertoning: true`): versleuteld en met een vast nummer, maar nog zonder gebeurtenis. `POST /objecten/:id/pii/vervallen` haalt voorvertoningen weg die de medewerker laat staan (bevestigde gegevens blijven).
- `POST /objecten/:id/pii/bevestig`: de voorvertoningen die nog in het document staan worden definitief, de rest vervalt, en het geanonimiseerde document wordt een nieuwe versie (soort anonimisering, met de bronversie). De versies tot en met de bronversie vragen daarna PPL 3.
- Per versie het niveau dat nodig is om haar te lezen (`ppl`) en of ze alleen voor informatiebeheer is (`beperkt`); dat vervangt `pii_tot_versie`.
- `POST /objecten/:id/pii/terugzetten`: een bevestigd gegeven terug in het document (binnen het eigen niveau); de volgende versie vraagt dat niveau.
- `POST /objecten/:id/versies/:n/terugzetten`: een eerdere versie als nieuwe versie (het niveau van die versie, en een reden).
- Sleutel vernietigen met `originelen: "beperken"`: de versies met persoonsgegevens zijn daarna alleen nog voor informatiebeheer. Vernietigen van de originelen zelf loopt via het vernietigingsproces (Archiefwet; Object Lock).

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
