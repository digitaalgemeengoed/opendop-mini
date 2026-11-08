// Zakelijk of persoonlijk (migratie 004): een persoonlijk stuk heeft geen
// metadata, staat in een eigen bucket, komt niet in de zoekindex en is
// alleen zichtbaar voor wie het vastlegde. Persoonlijk naar zakelijk kan
// altijd; andersom (nog) niet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { LokaalSleutelbeheer } from "../dist/sleutelbeheer.js";
import { bouwServer } from "../dist/server.js";
import { verwerkRonde, maakVerwerkers } from "../dist/worker.js";
import { OpenSearchZoekindex } from "../dist/zoekindex.js";
import { startNepOpenSearch } from "./nep-opensearch.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
let app, map, beheer, os, middelen, zoekindex;

const kop = (sub = "p-1") => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": "haarlem",
  "x-oa-actor": Buffer.from(JSON.stringify({ sub, naam: sub })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });
const docx = (s) => ({ formaat: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", codering: "base64", data: Buffer.from(`PK\u0003\u0004 ${s}`).toString("base64") });
const verwerk = () => verwerkRonde(beheer, maakVerwerkers(beheer, middelen, zoekindex), 1000);
const zoek = async (tekst, sub) => (await app.inject({ method: "GET", url: `/zoeken?tekst=${encodeURIComponent(tekst)}`, headers: kop(sub) })).json();

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-persoonlijk-"));
  os = await startNepOpenSearch();
  zoekindex = new OpenSearchZoekindex(os.adres, "oa-p-");
  middelen = { opslag: new LokaleOpslag(join(map, "opslag")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "sleutels")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex, dienstsleutel: SLEUTEL, log: false });
  beheer = new pg.Pool({ connectionString: BEHEER });
  await verwerk();
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await beheer.end();
  await huidigePool().end();
  await os.stop();
  await rm(map, { recursive: true, force: true });
});

let id;

test("persoonlijk vastleggen: geen metadata, eigen bucket, niet in de index", { skip: overslaan }, async () => {
  const fout = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", aard: "persoonlijk", metadata: { naam: "x" } } });
  assert.equal(fout.statusCode, 409);
  assert.equal(fout.json().fout, "persoonlijk-geen-metadata");

  const r = await app.inject({
    method: "POST",
    url: "/objecten",
    headers: kop(),
    payload: { objecttype: "document", aard: "persoonlijk", inhoud: docx("verlof"), weergave: html("<p>Mijn verlofaanvraag voor de zomer, kalfsvlees.</p>") },
  });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  id = o.identificatie;
  assert.equal(o.aard, "persoonlijk");
  assert.deepEqual(o.volledigheid, { volledig: true, ontbreekt: [] });
  assert.ok((await readdir(join(map, "opslag", "haarlem-persoonlijk", id))).length === 2);
  await assert.rejects(readdir(join(map, "opslag", "haarlem", id)));

  await verwerk();
  assert.equal((await zoek("kalfsvlees", "p-1")).resultaten.length, 0);
  const md = await app.inject({ method: "PUT", url: `/objecten/${id}/metadata`, headers: kop(), payload: { metadata: { naam: "x" } } });
  assert.equal(md.json().fout, "persoonlijk-geen-metadata");
});

test("alleen zichtbaar voor wie het vastlegde", { skip: overslaan }, async () => {
  for (const [method, url] of [["GET", `/objecten/${id}`], ["GET", `/objecten/${id}/gebeurtenissen`], ["GET", `/objecten/${id}/versies/1/inhoud`], ["GET", `/objecten/${id}/versies/1/weergaven/html`]]) {
    assert.equal((await app.inject({ method, url, headers: kop("iemand-anders") })).statusCode, 404, url);
    assert.equal((await app.inject({ method, url, headers: kop("p-1") })).statusCode, 200, url);
  }
  const v = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop("iemand-anders"), payload: { inhoud: html("<p>x</p>") } });
  assert.equal(v.statusCode, 404);
  const a = await app.inject({ method: "PUT", url: `/objecten/${id}/aard`, headers: kop("iemand-anders"), payload: { aard: "zakelijk" } });
  assert.equal(a.statusCode, 404);
});

test("nieuwe versie van een persoonlijk stuk blijft persoonlijk", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: docx("verlof 2"), weergave: html("<p>Mijn verlofaanvraag, aangepast, kalfsvlees.</p>") } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal((await readdir(join(map, "opslag", "haarlem-persoonlijk", id))).length, 4);
  await verwerk();
  assert.equal((await zoek("kalfsvlees", "p-1")).resultaten.length, 0);
});

test("persoonlijk naar zakelijk: kopie in het archief, in de index, voor iedereen", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "PUT", url: `/objecten/${id}/aard`, headers: kop(), payload: { aard: "zakelijk" } });
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.aard, "zakelijk");
  assert.equal(o.volledigheid.volledig, false);
  assert.equal((await readdir(join(map, "opslag", "haarlem", id))).length, 4);
  // Lezen komt nu uit het archief; de inhoud klopt (sha-256 en ontsleutelen).
  const inhoud = await app.inject({ method: "GET", url: `/objecten/${id}/versies/2/weergaven/html`, headers: kop("iemand-anders") });
  assert.equal(inhoud.statusCode, 200);
  assert.match(inhoud.body, /aangepast/);
  await verwerk();
  assert.equal((await zoek("kalfsvlees", "iemand-anders")).resultaten.length, 1);
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json();
  assert.deepEqual(g.at(-1).gegevens, { van: "persoonlijk", naar: "zakelijk" });

  const terug = await app.inject({ method: "PUT", url: `/objecten/${id}/aard`, headers: kop(), payload: { aard: "persoonlijk" } });
  assert.equal(terug.statusCode, 409);
  assert.equal(terug.json().fout, "persoonlijk-niet-toegestaan");
});

test("zonder aard: zakelijk, zoals voorheen", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: { naam: "Nota" } } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().aard, "zakelijk");
});
