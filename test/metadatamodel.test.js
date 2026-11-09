// Metadatamodellen uit het beheerportaal: catalogus, controle, publiceren
// per gemeente, en stukken die hun model houden.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { bouwServer } from "../dist/server.js";
import { GeenZoekindex } from "../dist/zoekindex.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
let app, map;

const kop = (gemeente = "bloemendaal", naam = "beheer@bloemendaal.test") => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": gemeente,
  "x-oa-actor": Buffer.from(JSON.stringify({ sub: "beheer:1", naam, beheerder: true })).toString("base64url"),
});
const vraag = (method, url, payload, k = kop()) => app.inject({ method, url, headers: k, payload });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }, { id: "zandvoort", naam: "Gemeente Zandvoort" }, { id: "bloemendaal", naam: "Gemeente Bloemendaal" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-md-"));
  app = bouwServer({ middelen: { opslag: new LokaleOpslag(map), sleutelbeheer: null, maxBytes: 1024 * 1024 }, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await huidigePool().end();
  await rm(map, { recursive: true, force: true });
});

const rgbz = (extra = []) => ({
  basis: "rgbz",
  velden: [
    { sleutel: "titel", aan: true, verplicht: true, label: "Titel van het stuk" },
    { sleutel: "beschrijving", aan: true, verplicht: false },
    { sleutel: "vertrouwelijkheidaanduiding", aan: true, verplicht: true },
    { sleutel: "auteur", aan: true, verplicht: true },
    { sleutel: "creatiedatum", aan: true, verplicht: false },
    { sleutel: "informatiecategorie", aan: true, verplicht: true },
    ...extra,
  ],
});

test("de catalogus: drie modellen en de waardelijsten, ook uit TOOI", { skip: overslaan }, async () => {
  const r = (await vraag("GET", "/metadatamodellen")).json();
  assert.deepEqual(Object.keys(r.modellen).sort(), ["mdto", "rgbz", "tmlo"]);
  assert.equal(r.waardelijsten["tooi-woo-informatiecategorie"].bron, "TOOI");
});

test("controleren legt niets vast en noemt fouten en waarschuwingen", { skip: overslaan }, async () => {
  const goed = (await vraag("POST", "/metadatamodellen/controle", { config: rgbz() })).json();
  assert.ok(goed.schema, "een schema als de keuze klopt");
  assert.ok(goed.problemen.some((p) => p.ernst === "waarschuwing" && p.sleutel === "creatiedatum"), "RGBZ noemt creatiedatum verplicht");
  assert.equal(goed.velden[0].label, "Titel van het stuk");
  const fout = (await vraag("POST", "/metadatamodellen/controle", { config: { basis: "rgbz", velden: [{ sleutel: "beschrijving", aan: true, verplicht: false }] } })).json();
  assert.equal(fout.schema, null);
  assert.ok(fout.problemen.some((p) => /titel/.test(p.melding)));
  const v = (await vraag("GET", "/objecttypen/document/versies")).json();
  assert.equal(v.length, 1, "nog alleen de gedeelde versie");
  assert.equal(v[0].gedeeld, true);
});

test("publiceren: een nieuwe versie voor deze gemeente; Zandvoort houdt de gedeelde", { skip: overslaan }, async () => {
  const fout = await vraag("POST", "/objecttypen/document/model", { config: { basis: "rgbz", velden: [{ sleutel: "beschrijving", aan: true, verplicht: false }] } });
  assert.equal(fout.statusCode, 422);
  const p = await vraag("POST", "/objecttypen/document/model", { config: rgbz([{ sleutel: "wijk", aan: true, verplicht: false, label: "Wijk", eigen: { type: "keuze", opties: ["Centrum", "Noord"] } }]) });
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().versie, 2);
  const h = (await vraag("GET", "/objecttypen/document")).json();
  assert.equal(h.versie, 2);
  assert.equal(h.schema["x-oa-model"], "rgbz");
  assert.deepEqual(h.schema.properties.wijk.enum, ["Centrum", "Noord"]);
  const z = (await vraag("GET", "/objecttypen/document", undefined, kop("zandvoort"))).json();
  assert.equal(z.versie, 1, "andere gemeenten merken niets");
  const v = (await vraag("GET", "/objecttypen/document/versies")).json();
  assert.deepEqual(v.map((x) => [x.versie, x.gedeeld, x.model, x.door]), [[2, false, "rgbz", "beheer@bloemendaal.test"], [1, true, null, null]]);
  assert.equal(v[0].config.basis, "rgbz");
});

test("stukken houden hun versie; een nieuw stuk krijgt het nieuwe model", { skip: overslaan }, async () => {
  // Een stuk van vóór de wijziging (versie 1) blijft met de oude velden werken.
  const oud = await vraag("POST", "/objecten", { objecttype: "document", metadata: { naam: "Oud stuk", informatiecategorie: "adviezen", vertrouwelijkheid: "intern" } });
  assert.equal(oud.statusCode, 422, "het actieve model is nu RGBZ: naam bestaat daar niet");
  const nieuw = await vraag("POST", "/objecten", {
    objecttype: "document",
    metadata: { titel: "Nieuw stuk", vertrouwelijkheidaanduiding: "zaakvertrouwelijk", auteur: "Team", informatiecategorie: "adviezen", wijk: "Noord" },
  });
  assert.equal(nieuw.statusCode, 201, nieuw.body);
  assert.equal(nieuw.json().objecttype.versie, 2);
  const z = await vraag("POST", "/objecten", { objecttype: "document", metadata: { naam: "Zandvoorts stuk", informatiecategorie: "adviezen", vertrouwelijkheid: "intern" } }, kop("zandvoort"));
  assert.equal(z.statusCode, 201, z.body);
  assert.equal(z.json().objecttype.versie, 1);
  // Metadata van een stuk met versie 1 wijzigen gaat tegen versie 1.
  const zid = z.json().identificatie;
  const w = await vraag("PUT", `/objecten/${zid}/metadata`, { metadata: { naam: "Zandvoorts stuk 2", informatiecategorie: "adviezen", vertrouwelijkheid: "openbaar" }, verwacht: z.json().volgnummer }, kop("zandvoort"));
  assert.equal(w.statusCode, 200, w.body);
});
