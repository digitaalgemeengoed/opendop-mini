// Classificeren en bewaren; vergrendelen bij een status; wijzigingsvoorstellen en vrijgave.
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
import { standaardConfig, telOp } from "@digitaalgemeengoed/oa-contract";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
const G = "velsen";
let app, map;

const kop = (actor = { sub: "m-1", naam: "Mieke" }) => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": G,
  "x-oa-actor": Buffer.from(JSON.stringify({ niveau: 1, ...actor })).toString("base64url"),
});
const MEDEWERKER = { sub: "m-1", naam: "Mieke" };
const VRIJGEVER = { sub: "v-1", naam: "Vera", vrijgever: true };
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });
const vraag = (method, url, payload, actor) => app.inject({ method, url, headers: kop(actor), payload });
const vandaag = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: G, naam: "Gemeente Velsen" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-cl-"));
  const middelen = { opslag: new LokaleOpslag(join(map, "o")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "s")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await huidigePool().end();
  await rm(map, { recursive: true, force: true });
});

const MODEL = {
  naam: "Velsen 2026",
  selectielijst: "gemeenten-2020",
  attributen: [{ sleutel: "biv", label: "BIV-classificatie", type: "keuze", opties: ["laag", "midden", "hoog"], verplicht: true }],
  vergrendelBij: ["definitief", "gearchiveerd"],
  termijnStartBij: "definitief",
  afwijkingen: [{ resultaat: "1.1", bewaartermijn: "P12Y", reden: "Langer voor de accountant" }],
};
const md = (status) => ({ titel: "Besluit inrichting", vertrouwelijkheidaanduiding: "intern", auteur: "Team", creatiedatum: "2026-11-10", informatiecategorie: "adviezen", status });
let id;

test("het classificatiemodel: statussen uit het metadatamodel, toetsen, publiceren", { skip: overslaan }, async () => {
  const leeg = (await vraag("GET", "/classificatiemodel")).json();
  assert.equal(leeg.actief, null);
  assert.equal(leeg.statussen, null, "het standaardmodel heeft geen status");
  assert.equal((await vraag("POST", "/objecttypen/document/model", { config: standaardConfig("rgbz") })).statusCode, 201);
  const k = (await vraag("GET", "/classificatiemodel")).json();
  assert.deepEqual(k.statussen, ["in bewerking", "ter vaststelling", "definitief", "gearchiveerd"]);
  assert.ok(k.selectielijsten[0].resultaten.length > 300);
  const c = (await vraag("POST", "/classificatiemodel/controle", { config: { ...MODEL, vergrendelBij: [] } })).json();
  assert.ok(c.problemen.some((p) => p.ernst === "fout" && /ten minste één status/.test(p.melding)));
  assert.equal((await vraag("POST", "/classificatiemodel", { config: { ...MODEL, vergrendelBij: [] } })).statusCode, 422);
  const p = await vraag("POST", "/classificatiemodel", { config: MODEL });
  assert.equal(p.statusCode, 201, p.body);
  assert.equal(p.json().versie, 1);
  const pan = (await vraag("GET", "/classificatie")).json();
  assert.equal(pan.model.config.naam, "Velsen 2026");
  assert.equal(pan.selectielijst.resultaten.find((r) => r.id === "1.1").bewaartermijn, "P12Y", "de afwijking is verwerkt");
});

test("classificeren: klasse en attributen; de termijn gaat in bij definitief", { skip: overslaan }, async () => {
  const o = await vraag("POST", "/objecten", { objecttype: "document", metadata: md("in bewerking"), inhoud: html("<h1>Besluit</h1><p>Eerste versie.</p>") });
  assert.equal(o.statusCode, 201, o.body);
  id = o.json().identificatie;
  assert.equal(o.json().vergrendeld, null);
  assert.equal(o.json().status, "in bewerking");
  assert.equal((await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "1.1" })).statusCode, 422, "biv is verplicht");
  assert.equal((await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "1.1", attributen: { biv: "extreem" } })).statusCode, 422);
  assert.equal((await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "99.1", attributen: { biv: "laag" } })).statusCode, 422);
  const k = await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "1.1", attributen: { biv: "midden" } });
  assert.equal(k.statusCode, 200, k.body);
  assert.equal(k.json().classificatie.modelversie, 1);
  assert.match(k.json().bewaren.uitleg, /12 jaar na definitief \(het stuk is nog niet definitief\)/);
  const d = await vraag("PUT", `/objecten/${id}/metadata`, { metadata: md("definitief") });
  assert.equal(d.statusCode, 200, d.body);
  assert.deepEqual(d.json().vergrendeld, { status: "definitief" });
  assert.equal(d.json().statusdata.definitief, vandaag());
  assert.equal(d.json().bewaren.archiefactiedatum, telOp(vandaag(), "P12Y"));
  const ev = (await vraag("GET", `/objecten/${id}/gebeurtenissen`)).json();
  assert.ok(ev.some((e) => e.type === "classificatie.vastgelegd"));
});

test("vergrendeld: geen nieuwe versie of metadata, wel een wijzigingsvoorstel", { skip: overslaan }, async () => {
  const v = await vraag("POST", `/objecten/${id}/versies`, { inhoud: html("<h1>Besluit</h1><p>Gewijzigd.</p>") });
  assert.equal(v.statusCode, 409);
  assert.equal(v.json().fout, "vergrendeld");
  assert.equal((await vraag("PUT", `/objecten/${id}/metadata`, { metadata: md("in bewerking") })).statusCode, 409, "een medewerker geeft niet zelf vrij");
  assert.equal((await vraag("PUT", `/objecten/${id}/classificatie`, { resultaat: "1.1", attributen: { biv: "hoog" } })).statusCode, 409);
  // Ongewijzigde inhoud is geen fout en geen versie.
  assert.equal((await vraag("POST", `/objecten/${id}/versies`, { inhoud: html("<h1>Besluit</h1><p>Eerste versie.</p>") })).statusCode, 201);
  assert.equal((await vraag("POST", `/objecten/${id}/voorstellen`, { inhoud: html("<h1>Besluit</h1><p>Eerste versie.</p>"), reden: "Niets veranderd" })).statusCode, 409);
  const vs = await vraag("POST", `/objecten/${id}/voorstellen`, { inhoud: html("<h1>Besluit</h1><p>Gewijzigd: typefout in de datum.</p>"), reden: "Typefout in de datum" });
  assert.equal(vs.statusCode, 201, vs.body);
  assert.equal(vs.json().status, "open");
  assert.equal(vs.json().bronversie, 1);
  const o = (await vraag("GET", `/objecten/${id}`)).json();
  assert.equal(o.voorstellen, 1);
  assert.equal(o.versies.length, 1, "het voorstel staat naast het stuk, niet in de versies");
});

test("vrijgeven: een andere vrijgever keurt goed (nieuwe versie) of wijst af; daarna vrijgeven met een status", { skip: overslaan }, async () => {
  assert.equal((await vraag("GET", "/voorstellen")).statusCode, 403, "alleen een vrijgever ziet de lijst");
  const lijst = (await vraag("GET", "/voorstellen", undefined, VRIJGEVER)).json();
  assert.equal(lijst.length, 1);
  assert.equal(lijst[0].titel, "Besluit inrichting");
  const vid = lijst[0].id;
  const w = await vraag("GET", `/voorstellen/${vid}/weergave`, undefined, VRIJGEVER);
  assert.equal(w.statusCode, 200, w.body);
  assert.match(w.json().data, /typefout in de datum/);
  assert.equal((await vraag("GET", `/voorstellen/${vid}/weergave`, undefined, { sub: "m-2", naam: "Ander" })).statusCode, 403);
  assert.equal((await vraag("POST", `/voorstellen/${vid}/beoordeling`, { besluit: "goedkeuren" })).statusCode, 403, "geen vrijgever");
  assert.equal((await vraag("POST", `/voorstellen/${vid}/beoordeling`, { besluit: "goedkeuren" }, { ...MEDEWERKER, vrijgever: true })).statusCode, 403, "niet het eigen voorstel");
  const g = await vraag("POST", `/voorstellen/${vid}/beoordeling`, { besluit: "goedkeuren", toelichting: "Akkoord" }, VRIJGEVER);
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().status, "goedgekeurd");
  assert.equal(g.json().beoordeling.versie, 2);
  const o = (await vraag("GET", `/objecten/${id}`)).json();
  assert.equal(o.versies.length, 2);
  assert.equal(o.versies[1].door, "m-1", "de versie staat op naam van de indiener");
  assert.deepEqual(o.vergrendeld, { status: "definitief" }, "het stuk blijft vergrendeld");
  assert.equal(o.voorstellen, 0);
  assert.equal((await vraag("POST", `/voorstellen/${vid}/beoordeling`, { besluit: "afwijzen" }, VRIJGEVER)).statusCode, 409, "al beoordeeld");
  // Afwijzen: geen versie.
  const v2 = (await vraag("POST", `/objecten/${id}/voorstellen`, { inhoud: html("<h1>Besluit</h1><p>Nog een wijziging.</p>"), reden: "Nog iets" })).json();
  const a = await vraag("POST", `/voorstellen/${v2.id}/beoordeling`, { besluit: "afwijzen", toelichting: "Niet nodig" }, VRIJGEVER);
  assert.equal(a.json().status, "afgewezen");
  assert.equal((await vraag("GET", `/objecten/${id}`)).json().versies.length, 2);
  assert.equal((await vraag("GET", `/voorstellen?object=${id}`)).json().length, 2, "de indiener ziet de voorstellen bij het stuk");
  // Vrijgeven: de vrijgever zet de status terug; daarna kan de medewerker weer versies maken.
  const vrij = await vraag("PUT", `/objecten/${id}/metadata`, { metadata: md("in bewerking") }, VRIJGEVER);
  assert.equal(vrij.statusCode, 200, vrij.body);
  assert.equal(vrij.json().vergrendeld, null);
  assert.equal(vrij.json().statusdata.definitief, vandaag(), "de eerste dag van definitief blijft staan");
  assert.equal((await vraag("POST", `/objecten/${id}/versies`, { inhoud: html("<h1>Besluit</h1><p>Na vrijgave.</p>") })).statusCode, 201);
  const ev = (await vraag("GET", `/objecten/${id}/gebeurtenissen`)).json().map((e) => e.type);
  for (const t of ["voorstel.ingediend", "voorstel.goedgekeurd", "voorstel.afgewezen"]) assert.ok(ev.includes(t), t);
});
