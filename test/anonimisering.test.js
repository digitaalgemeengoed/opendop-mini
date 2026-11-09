// Geanonimiseerde weergaven (migratie 005): naast het origineel en de
// gewone weergave, met een volgnummer per correctie; de gebeurtenis bevat
// alleen aantallen.
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
  map = await mkdtemp(join(tmpdir(), "oa-anon-"));
  os = await startNepOpenSearch();
  zoekindex = new OpenSearchZoekindex(os.adres, "oa-a-");
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

test("geanonimiseerde weergave vastleggen en lezen; het origineel blijft", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: { naam: "Besluit" }, inhoud: docx("besluit"), weergave: html("<p>Geachte heer De Vries, uw BSN 111222333.</p>") } });
  assert.equal(r.statusCode, 201, r.body);
  id = r.json().identificatie;
  const anon = html("<p>Geachte heer [naam], uw BSN [BSN].</p>");
  const a = await app.inject({ method: "POST", url: `/objecten/${id}/versies/1/anonimisering`, headers: kop(), payload: { inhoud: anon, overzicht: { naam: 1, bsn: 1 } } });
  assert.equal(a.statusCode, 201, a.body);
  const w = a.json().versies[0].weergaven;
  assert.deepEqual(w.map((x) => [x.formaat, x.soort ?? "weergave", x.volgnummer ?? null]), [["html", "weergave", null], ["html", "geanonimiseerd", 1]]);
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json().at(-1);
  assert.equal(g.type, "anonimisering.vastgelegd");
  assert.deepEqual(g.gegevens.afgeschermd, { naam: 1, bsn: 1 });
  assert.ok(!JSON.stringify(g).includes("De Vries"));
  const lees = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html?soort=geanonimiseerd`, headers: kop() });
  assert.equal(lees.body, anon.data);
  const orig = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html`, headers: kop() });
  assert.match(orig.body, /De Vries/);
});

test("ongewijzigd: niets nieuws; een correctie krijgt volgnummer 2", { skip: overslaan }, async () => {
  const anon = html("<p>Geachte heer [naam], uw BSN [BSN].</p>");
  const zelfde = await app.inject({ method: "POST", url: `/objecten/${id}/versies/1/anonimisering`, headers: kop(), payload: { inhoud: anon, overzicht: { naam: 1, bsn: 1 } } });
  assert.equal(zelfde.json().versies[0].weergaven.length, 2);
  const beter = html("<p>Geachte [naam], uw BSN [BSN].</p>");
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies/1/anonimisering`, headers: kop(), payload: { inhoud: beter, overzicht: { naam: 1, bsn: 1 } } });
  assert.equal(r.json().versies[0].weergaven.at(-1).volgnummer, 2);
  const lees = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html?soort=geanonimiseerd`, headers: kop() });
  assert.equal(lees.body, beter.data);
  const fout = await app.inject({ method: "POST", url: `/objecten/${id}/versies/9/anonimisering`, headers: kop(), payload: { inhoud: beter, overzicht: {} } });
  assert.equal(fout.statusCode, 404);
});

test("de zoekindex leest de gewone weergave, niet de geanonimiseerde", { skip: overslaan }, async () => {
  await verwerk();
  assert.equal((await zoek("Vries", "p-1")).resultaten.length, 1);
});
