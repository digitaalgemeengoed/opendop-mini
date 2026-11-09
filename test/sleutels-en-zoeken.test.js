// Fase 1b: versleuteling per object met OpenBao (OA-ADR-008) en zoeken met
// OpenSearch via het register (OA-ADR-007). Tegen een echte PostgreSQL en
// nabootsingen van OpenBao en OpenSearch (de echte OpenSearch-client).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { bouwServer } from "../dist/server.js";
import { verwerkRonde, maakVerwerkers } from "../dist/worker.js";
import { OpenBaoSleutelbeheer, LokaalSleutelbeheer } from "../dist/sleutelbeheer.js";
import { OpenSearchZoekindex, GeenZoekindex, tekstUitHtml } from "../dist/zoekindex.js";
import { startNepOpenBao } from "./nep-openbao.js";
import { startNepOpenSearch } from "./nep-opensearch.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
const BAO_TOKEN = "s.test-token";

let app, map, bao, os, middelen, zoekindex, beheer, verwerkers;

const kop = (gemeente = "haarlem", sub = "medewerker-1") => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": gemeente,
  "x-oa-actor": Buffer.from(JSON.stringify({ sub, naam: sub })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });
const metadata = (naam) => ({ naam, informatiecategorie: "adviezen", vertrouwelijkheid: "openbaar" });
const verwerk = () => verwerkRonde(beheer, verwerkers);

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }, { id: "zandvoort", naam: "Gemeente Zandvoort" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-1b-"));
  bao = await startNepOpenBao(BAO_TOKEN);
  os = await startNepOpenSearch();
  middelen = { opslag: new LokaleOpslag(join(map, "opslag")), sleutelbeheer: new OpenBaoSleutelbeheer(bao.adres, BAO_TOKEN), maxBytes: 1024 * 1024 };
  zoekindex = new OpenSearchZoekindex(os.adres, "oa-test-");
  app = bouwServer({ middelen, zoekindex, dienstsleutel: SLEUTEL, log: false });
  beheer = new pg.Pool({ connectionString: BEHEER });
  // Eerst de outbox van eerdere tests leegmaken, zonder index.
  await verwerkRonde(beheer, maakVerwerkers(beheer, middelen, new GeenZoekindex()), 1000);
  verwerkers = maakVerwerkers(beheer, middelen, zoekindex);
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await beheer.end();
  await huidigePool().end();
  await bao.stop();
  await os.stop();
  await rm(map, { recursive: true, force: true });
});

test("tekst uit html: blokken gescheiden, script telt niet mee", () => {
  assert.equal(tekstUitHtml("<h1>Titel</h1><p>Een <b>vet</b> woord</p><script>x()</script>"), "Titel Een vet woord");
});

let id;
const GEHEIM = "Het parkeerterrein aan de Zeeweg wordt herontwikkeld";

test("een nieuw object krijgt een eigen sleutel in OpenBao; de opslag bevat alleen versleutelde inhoud", { skip: overslaan }, async () => {
  const r = await app.inject({
    method: "POST", url: "/objecten", headers: kop(),
    payload: { objecttype: "document", metadata: metadata("Advies Zeeweg"), inhoud: html(`<h1>Advies</h1><p>${GEHEIM}.</p>`) },
  });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  id = o.identificatie;
  assert.equal(o.versleuteld, true);
  assert.ok(bao.sleutels.has(`oa-haarlem-${id}`), "transit-sleutel per object");
  const bestanden = await readdir(join(map, "opslag", "haarlem", id));
  const blob = await readFile(join(map, "opslag", "haarlem", id, bestanden[0]));
  assert.ok(!blob.toString("latin1").includes("Zeeweg"), "geen leesbare tekst in de opslag");
  const inhoud = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/inhoud`, headers: kop() });
  assert.equal(inhoud.statusCode, 200);
  assert.match(inhoud.body, /Zeeweg/);
});

test("de worker indexeert per gemeente; zoeken bevestigt in het register", { skip: overslaan }, async () => {
  await verwerk();
  assert.ok(os.indexen.get("oa-test-haarlem").has(id));
  const r = await app.inject({ method: "GET", url: "/zoeken?tekst=zeeweg", headers: kop() });
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json();
  assert.equal(a.resultaten.length, 1);
  assert.equal(a.resultaten[0].identificatie, id);
  assert.equal(a.resultaten[0].metadata.naam, "Advies Zeeweg", "metadata uit het register");
  assert.match(a.resultaten[0].fragmenten[0], /<mark>zeeweg<\/mark>/i);
  const z = await app.inject({ method: "GET", url: "/zoeken?tekst=zeeweg", headers: kop("zandvoort") });
  assert.equal(z.json().resultaten.length, 0, "Zandvoort zoekt in een eigen index");
});

test("een treffer die het register niet kent, komt niet terug", { skip: overslaan }, async () => {
  os.indexen.get("oa-test-haarlem").set("00000000-0000-0000-0000-000000000000", { naam: "Spook", tekst: "zeeweg" });
  const r = (await app.inject({ method: "GET", url: "/zoeken?tekst=zeeweg", headers: kop() })).json();
  assert.equal(r.resultaten.length, 1);
  assert.equal(r.nietBevestigd, 1);
});

test("een filter wordt ook op het register toegepast, niet alleen op de index", { skip: overslaan }, async () => {
  // Index loopt achter: daar staat nog "adviezen", in het register al iets anders.
  await app.inject({ method: "PUT", url: `/objecten/${id}/metadata`, headers: kop(), payload: { metadata: { ...metadata("Advies Zeeweg"), informatiecategorie: "onderzoeksrapporten" } } });
  const r = (await app.inject({ method: "GET", url: "/zoeken?tekst=zeeweg&informatiecategorie=adviezen", headers: kop() })).json();
  assert.equal(r.resultaten.length, 0);
});

test("een ander metadatamodel (RGBZ): de index en de filters volgen de rollen", { skip: overslaan }, async () => {
  const { schemaUitConfig, standaardConfig } = await import("@digitaalgemeengoed/oa-contract");
  const t = await app.inject({ method: "POST", url: "/objecttypen", headers: kop(), payload: { naam: "stuk-rgbz", titel: "Stuk (RGBZ)", schema: schemaUitConfig(standaardConfig("rgbz")) } });
  assert.equal(t.statusCode, 201, t.body);
  const metadata = { titel: "Notitie Duinpad", vertrouwelijkheidaanduiding: "intern", auteur: "Team Wegen", creatiedatum: "2026-11-09", taal: "dut", informatiecategorie: "adviezen" };
  const fout = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "stuk-rgbz", metadata: { ...metadata, creatiedatum: "9 november" } } });
  assert.equal(fout.statusCode, 422, "een datum moet jjjj-mm-dd zijn");
  const o = await app.inject({
    method: "POST",
    url: "/objecten",
    headers: kop(),
    payload: { objecttype: "stuk-rgbz", metadata, inhoud: { formaat: "html", mediaType: "text/html", codering: "tekst", data: "<p>Het duinpad wordt verlegd.</p>" } },
  });
  assert.equal(o.statusCode, 201, o.body);
  const rid = o.json().identificatie;
  await verwerk();
  const doc = os.indexen.get("oa-test-haarlem").get(rid);
  assert.equal(doc.naam, "Notitie Duinpad", "de titel staat in de index onder naam");
  assert.equal(doc.vertrouwelijkheid, "intern");
  const r = await app.inject({ method: "GET", url: "/zoeken?tekst=duinpad&vertrouwelijkheid=intern", headers: kop() });
  const a = r.json();
  assert.equal(a.resultaten.length, 1, r.body);
  assert.deepEqual(a.resultaten[0].kern, { titel: "Notitie Duinpad", vertrouwelijkheid: "intern", auteur: "Team Wegen", datum: "2026-11-09", taal: "dut", informatiecategorie: "adviezen" });
  const geen = await app.inject({ method: "GET", url: "/zoeken?tekst=duinpad&vertrouwelijkheid=openbaar", headers: kop() });
  assert.equal(geen.json().resultaten.length, 0);
});

test("onleesbaar maken: sleutel weg, inhoud 410, registratie en gebeurtenissen blijven, uit de index", { skip: overslaan }, async () => {
  const kort = await app.inject({ method: "POST", url: `/objecten/${id}/onleesbaar`, headers: kop(), payload: { reden: "kort" } });
  assert.equal(kort.statusCode, 400, "een reden van minstens tien tekens");
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/onleesbaar`, headers: kop("haarlem", "beheerder-1"), payload: { reden: "Vernietiging volgens selectielijst, verzoek 2026-17" } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().onleesbaarGemaakt);
  assert.ok(!bao.sleutels.has(`oa-haarlem-${id}`), "transit-sleutel verwijderd");
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/inhoud`, headers: kop() })).statusCode, 410);
  assert.equal((await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: html("<p>nieuw</p>") } })).statusCode, 410);
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).statusCode, 200, "registratie blijft");
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json();
  assert.equal(g.at(-1).type, "object.onleesbaar-gemaakt");
  assert.equal(g.at(-1).gegevens.reden, "Vernietiging volgens selectielijst, verzoek 2026-17");
  await verwerk();
  assert.ok(!os.indexen.get("oa-test-haarlem").has(id), "uit de index");
  const db = new pg.Client({ connectionString: BEHEER });
  await db.connect();
  const rij = (await db.query("SELECT sleutel_verpakt FROM objecten WHERE identificatie = $1", [id])).rows[0];
  await db.end();
  assert.equal(rij.sleutel_verpakt, null);
});

test("een niet-versleuteld object kan niet onleesbaar worden gemaakt", { skip: overslaan }, async () => {
  const zonder = bouwServer({ middelen: { ...middelen, sleutelbeheer: null }, zoekindex, dienstsleutel: SLEUTEL, log: false });
  const o = (await zonder.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: metadata("Zonder sleutel"), inhoud: html("<p>x</p>") } })).json();
  assert.equal(o.versleuteld, false);
  const r = await app.inject({ method: "POST", url: `/objecten/${o.identificatie}/onleesbaar`, headers: kop(), payload: { reden: "Probeer het toch maar eens" } });
  assert.equal(r.statusCode, 409);
  await zonder.close();
});

test("zoeken zonder index zegt dat het uit staat", { skip: overslaan }, async () => {
  const uit = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
  const r = await uit.inject({ method: "GET", url: "/zoeken?tekst=zeeweg", headers: kop() });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().fout, "zoeken-uit");
  await uit.close();
});

test("het platform kan zijn OpenBao-token vernieuwen", { skip: overslaan }, async () => {
  assert.equal(await middelen.sleutelbeheer.vernieuwToken(), 2764800);
});

test("lokaal sleutelbeheer gedraagt zich hetzelfde", async () => {
  const m = await mkdtemp(join(tmpdir(), "oa-sleutels-"));
  const sb = new LokaalSleutelbeheer(m);
  const oid = "11111111-2222-3333-4444-555555555555";
  const verpakt = await sb.maakObjectsleutel("haarlem", oid);
  const dek = await sb.pakUit("haarlem", oid, verpakt);
  assert.equal(dek.length, 32);
  await sb.vernietig("haarlem", oid);
  await assert.rejects(sb.pakUit("haarlem", oid, verpakt), /bestaat niet meer/);
  await rm(m, { recursive: true, force: true });
});
