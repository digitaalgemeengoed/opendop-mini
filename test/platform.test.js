// Integratietest van de Object Service tegen een echte PostgreSQL.
// Nodig: TEST_DATABASE_URL_BEHEER (eigenaar) en TEST_DATABASE_URL (als oa_app),
// op een lege database. Zonder die variabelen wordt de test overgeslagen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migreer } from "../dist/migreer.js";
import { maakPool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { bouwServer } from "../dist/server.js";
import { verwerkRonde, maakVerwerkers } from "../dist/worker.js";
import { GeenZoekindex } from "../dist/zoekindex.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";

let app, map, pool, middelen;

const actor = (sub) => Buffer.from(JSON.stringify({ sub, naam: sub })).toString("base64url");
const kop = (gemeente = "haarlem", sub = "medewerker-1") => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": gemeente,
  "x-oa-actor": actor(sub),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, {
    gemeenten: [
      { id: "haarlem", naam: "Gemeente Haarlem" },
      { id: "zandvoort", naam: "Gemeente Zandvoort" },
    ],
  });
  pool = maakPool(APP);
  map = await mkdtemp(join(tmpdir(), "oa-opslag-"));
  middelen = { opslag: new LokaleOpslag(map), sleutelbeheer: null, maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await pool.end();
  await rm(map, { recursive: true, force: true });
});

test("zonder dienstsleutel geen toegang", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "GET", url: "/objecttypen", headers: { "x-oa-gemeente": "haarlem" } });
  assert.equal(r.statusCode, 401);
});

test("het gedeelde objecttype document is beschikbaar", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "GET", url: "/objecttypen/document", headers: kop() });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().versie, 1);
});

let id;

test("een object mag onvolledig zijn; wat ontbreekt wordt genoemd", { skip: overslaan }, async () => {
  const r = await app.inject({
    method: "POST",
    url: "/objecten",
    headers: kop(),
    payload: { objecttype: "document", metadata: { naam: "Raadsvoorstel fietsenstalling" }, inhoud: html("<h1>Raadsvoorstel</h1>") },
  });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  id = o.identificatie;
  assert.equal(o.versies.length, 1);
  assert.deepEqual(o.volledigheid.ontbreekt, ["informatiecategorie", "vertrouwelijkheid"]);
});

test("een waarde buiten de waardelijst wordt geweigerd", { skip: overslaan }, async () => {
  const r = await app.inject({
    method: "PUT",
    url: `/objecten/${id}/metadata`,
    headers: kop(),
    payload: { metadata: { naam: "Raadsvoorstel", vertrouwelijkheid: "supergeheim" } },
  });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().details[0].veld, "vertrouwelijkheid");
});

test("metadata vastleggen met verwacht volgnummer; een verouderde stand geeft 409", { skip: overslaan }, async () => {
  const huidig = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  const metadata = {
    naam: "Raadsvoorstel fietsenstalling",
    informatiecategorie: "vergaderstukken decentrale overheden",
    vertrouwelijkheid: "openbaar",
  };
  const ok = await app.inject({
    method: "PUT",
    url: `/objecten/${id}/metadata`,
    headers: kop(),
    payload: { metadata, verwachteVolgnummer: huidig.volgnummer },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().volledigheid.volledig, true);

  const oud = await app.inject({
    method: "PUT",
    url: `/objecten/${id}/metadata`,
    headers: kop(),
    payload: { metadata: { ...metadata, naam: "Anders" }, verwachteVolgnummer: huidig.volgnummer },
  });
  assert.equal(oud.statusCode, 409);
});

test("een nieuwe versie; dezelfde inhoud levert geen versie op", { skip: overslaan }, async () => {
  const r1 = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: html("<h1>Raadsvoorstel</h1><p>Nieuw</p>") } });
  assert.equal(r1.json().versies.length, 2);
  const r2 = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: html("<h1>Raadsvoorstel</h1><p>Nieuw</p>") } });
  assert.equal(r2.json().versies.length, 2);
  const inhoud = await app.inject({ method: "GET", url: `/objecten/${id}/versies/2/inhoud`, headers: kop() });
  assert.equal(inhoud.body, "<h1>Raadsvoorstel</h1><p>Nieuw</p>");
});

test("elke vastlegging is een gebeurtenis", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() });
  assert.deepEqual(
    r.json().map((g) => g.type),
    ["object.aangemaakt", "versie.vastgelegd", "metadata.vastgelegd", "versie.vastgelegd"],
  );
});

test("een andere gemeente ziet het object niet (Row Level Security)", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop("zandvoort") });
  assert.equal(r.statusCode, 404);
  const db = new pg.Client({ connectionString: APP });
  await db.connect();
  const zonder = await db.query("SELECT count(*)::int AS n FROM objecten");
  await db.end();
  assert.equal(zonder.rows[0].n, 0, "zonder gemeente-instelling ziet oa_app niets");
});

test("gebeurtenissen kunnen niet worden gewijzigd", { skip: overslaan }, async () => {
  const db = new pg.Client({ connectionString: BEHEER });
  await db.connect();
  await assert.rejects(db.query("UPDATE gebeurtenissen SET type = 'x'"), /alleen toegevoegd/);
  await db.end();
});

test("een objecttype publiceren levert een nieuwe versie; bestaande objecten houden hun versie", { skip: overslaan }, async () => {
  const basis = (await app.inject({ method: "GET", url: "/objecttypen/document", headers: kop() })).json();
  const schema = { ...basis.schema, required: [...basis.schema.required, "omschrijving"] };
  const r = await app.inject({ method: "POST", url: "/objecttypen", headers: kop(), payload: { naam: "document", titel: "Document (Haarlem)", schema } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().versie, 2);
  const o = (await app.inject({ method: "GET", url: `/objecten/${id}`, headers: kop() })).json();
  assert.equal(o.objecttype.versie, 1);
  assert.equal(o.volledigheid.volledig, true);
  const z = (await app.inject({ method: "GET", url: "/objecttypen/document", headers: kop("zandvoort") })).json();
  assert.equal(z.versie, 1, "Zandvoort ziet het type van Haarlem niet");
});

test("de worker verwerkt de outbox", { skip: overslaan }, async () => {
  const beheer = new pg.Pool({ connectionString: BEHEER });
  const n = await verwerkRonde(beheer, maakVerwerkers(beheer, middelen, new GeenZoekindex()));
  assert.ok(n >= 4);
  const rest = await beheer.query("SELECT count(*)::int AS n FROM outbox WHERE status = 'wachtend'");
  assert.equal(rest.rows[0].n, 0);
  await beheer.end();
});
