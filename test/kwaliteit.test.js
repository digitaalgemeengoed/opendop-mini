// Kwaliteit van het anonimiseren: metingen bij bevestigen, zonder waarden; de samenvatting.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { LokaalSleutelbeheer } from "../dist/sleutelbeheer.js";
import { bouwServer } from "../dist/server.js";
import { GeenZoekindex } from "../dist/zoekindex.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
let app, map;

const kop = (gemeente = "heemstede") => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": gemeente,
  "x-oa-actor": Buffer.from(JSON.stringify({ sub: "m-1", naam: "m-1", niveau: 1 })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }, { id: "heemstede", naam: "Gemeente Heemstede" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-kw-"));
  const middelen = { opslag: new LokaleOpslag(join(map, "o")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "s")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await huidigePool().end();
  await rm(map, { recursive: true, force: true });
});

async function bevestigMet(items, k = kop()) {
  const o = await app.inject({ method: "POST", url: "/objecten", headers: k, payload: { objecttype: "document", metadata: { naam: "Brief", informatiecategorie: "adviezen", vertrouwelijkheid: "intern" }, inhoud: html("<p>Brief</p>") } });
  assert.equal(o.statusCode, 201, o.body);
  return app.inject({
    method: "POST",
    url: `/objecten/${o.json().identificatie}/pii/bevestig`,
    headers: k,
    payload: { inhoud: html("<p>Brief [PERSOON 1]</p>"), bronversie: 1, behouden: [], meting: { motor: "OpenAnonymiser 1.2", items } },
  });
}

const tel = { soort: "telefoon", bron: "medewerker", uitkomst: "toegevoegd", standaard: true, vorm: "9-9", lengte: "middel", signaal: "telefoon", plekken: 1 };
const naam = { soort: "naam", bron: "model", score: 0.91, uitkomst: "bevestigd", standaard: true, vorm: "Aa Aa", lengte: "middel", plekken: 2 };
const straat = { soort: "naam", bron: "model", score: 0.55, uitkomst: "gelaten", reden: "geen-persoonsgegeven", standaard: true, vorm: "Aa", lengte: "middel", plekken: 1 };
const wethouder = { soort: "naam", bron: "model", score: 0.88, uitkomst: "gelaten", reden: "mag-openbaar", standaard: true, vorm: "Aa Aa", plekken: 1 };
const datum = { soort: "datum", bron: "patroon", uitkomst: "bevestigd", standaard: false, vorm: "9 a", plekken: 1, categorie: { van: "c1", naar: "c2" } };

test("een meting mag geen waarden bevatten", { skip: overslaan }, async () => {
  assert.equal((await bevestigMet([{ ...tel, vorm: "06-51209934" }])).statusCode, 400, "cijfers in de vorm");
  assert.equal((await bevestigMet([{ ...naam, vorm: "Jan Bakker" }])).statusCode, 400, "letters in de vorm");
  assert.equal((await bevestigMet([{ ...tel, signaal: "Bakker" }])).statusCode, 400, "alleen signaalwoorden van de lijst");
  // Een onbekend veld valt eruit (Fastify haalt het weg); de waarde wordt dus niet bewaard.
  assert.equal((await bevestigMet([{ ...tel, waarde: "06-51209934" }], kop("haarlem"))).statusCode, 201);
  const h = await app.inject({ method: "GET", url: "/anonimisering/kwaliteit?drempel=2", headers: kop("haarlem") });
  assert.equal(h.json().metingen, 1);
  assert.equal(h.body.includes("06-51209934"), false, "de waarde staat nergens");
});

test("metingen bij bevestigen; de samenvatting per soort, score en vorm", { skip: overslaan }, async () => {
  for (let i = 0; i < 3; i++) assert.equal((await bevestigMet([naam, straat, tel, wethouder, datum])).statusCode, 201);
  const k = await app.inject({ method: "GET", url: "/anonimisering/kwaliteit?drempel=3", headers: kop() });
  assert.equal(k.statusCode, 200, k.body);
  const j = k.json();
  assert.equal(j.metingen, 3);
  assert.equal(j.gegevens, 15);
  const n = j.perSoort.find((s) => s.soort === "naam");
  assert.equal(n.voorgesteld, 9);
  assert.equal(n.bevestigd, 3);
  assert.deepEqual(n.gelaten, { "geen-persoonsgegeven": 3, "mag-openbaar": 3, "verkeerde-soort": 0, zonder: 0 });
  assert.equal(n.juist, 6, "bevestigd en mag-openbaar: de herkenning klopte");
  assert.equal(n.onterecht, 3);
  assert.equal(n.precisie, 0.667);
  assert.equal(n.scores.onterecht[1], 3, "score 0,55 valt in 0,5–0,6");
  const t = j.perSoort.find((s) => s.soort === "telefoon");
  assert.equal(t.toegevoegd, 3);
  assert.equal(t.gevonden, 0);
  const d = j.perSoort.find((s) => s.soort === "datum");
  assert.equal(d.keuze, 3, "standaard uit: een keuze, geen vondst");
  assert.equal(d.juist, 0);
  assert.deepEqual(j.grondslag, [{ van: "c1", naar: "c2", aantal: 3 }]);
  const gemist = j.vormen.find((v) => v.klasse === "gemist");
  assert.deepEqual([gemist.soort, gemist.vorm, gemist.regex, gemist.aantal, gemist.metingen], ["telefoon", "9-9", "\\d+-\\d+", 3, 3]);
  assert.deepEqual(gemist.signaalwoorden, [{ woord: "telefoon", aantal: 3 }]);
  assert.ok(j.vormen.some((v) => v.klasse === "onterecht" && v.vorm === "Aa"));
  assert.deepEqual(j.perMotor.map((m) => [m.motor, m.metingen]), [["OpenAnonymiser 1.2", 3]]);
  // Met een hogere drempel blijven de vormen verborgen.
  const hoog = (await app.inject({ method: "GET", url: "/anonimisering/kwaliteit?drempel=5", headers: kop() })).json();
  assert.equal(hoog.vormen.length, 0);
  assert.equal(hoog.verborgen, 2);
  // Een andere gemeente ziet niets.
  assert.equal((await app.inject({ method: "GET", url: "/anonimisering/kwaliteit", headers: kop("haarlem") })).json().metingen, 1, "alleen de eigen meting");
});
