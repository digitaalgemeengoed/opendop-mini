# Wijzigingen

## 0.3.0 — 2026-11-08

Migratie 003: een versie is het origineel (docx, odt …); de html gaat mee als **weergave** (tabel `weergaven`, versleuteld zoals de versie). "Ongewijzigd" wordt bepaald op de weergave, omdat een docx of odt bij elke export anders is. `GET /objecten/:id/versies/:n/weergaven/:formaat`. De zoekindex leest de html-weergave.

## 0.2.0 — 2026-11-07

Fase 1b. Versleuteling per object met OpenBao en onleesbaar maken door de sleutel te vernietigen (OA-ADR-008). Zoeken met OpenSearch, één index per gemeente, met bevestiging van elk resultaat in het register (OA-ADR-007). Beide optioneel. De worker indexeert na elke vastlegging.

## 0.1.1 — 2026-11-07

S3-opslag in de uitrol is SILO, de open-source voortzetting van MinIO (OA-ADR-006).

## 0.1.0 — 2026-11-07

Fase 1 van het werkende prototype: contract, minimaal platform, integratielaag met twee ingangen, assistentkern, paneel en een demo-werkomgeving met de modules metadateren en toegankelijkheid.
