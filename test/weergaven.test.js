// Het origineel als versie, met een html-weergave ernaast (migratie 003).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migreer } from "../dist/migreer.js";
import { maakPool, huidigePool } from "../dist/db.js";
import { LokaleOpslag } from "../dist/opslag.js";
import { LokaalSleutelbeheer } from "../dist/sleutelbeheer.js";
import { bouwServer } from "../dist/server.js";
import { verwerkRonde, maakVerwerkers } from "../dist/worker.js";
import { OpenSearchZoekindex, GeenZoekindex } from "../dist/zoekindex.js";
import { startNepOpenSearch } from "./nep-opensearch.js";

const BEHEER = process.env.TEST_DATABASE_URL_BEHEER;
const APP = process.env.TEST_DATABASE_URL;
const overslaan = !BEHEER || !APP;
const SLEUTEL = "test-dienstsleutel-0123456789";
let app, map, beheer, os, middelen;

const kop = () => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": "haarlem",
  "x-oa-actor": Buffer.from(JSON.stringify({ sub: "m-1", naam: "M" })).toString("base64url"),
});
const docx = (s) => ({ formaat: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", codering: "base64", data: Buffer.from(`PK\u0003\u0004 ${s}`).toString("base64") });
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });
const metadata = { naam: "Nota Kenaupark", informatiecategorie: "adviezen", vertrouwelijkheid: "openbaar" };

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-weergave-"));
  os = await startNepOpenSearch();
  middelen = { opslag: new LokaleOpslag(join(map, "opslag")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "sleutels")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new OpenSearchZoekindex(os.adres, "oa-w-"), dienstsleutel: SLEUTEL, log: false });
  beheer = new pg.Pool({ connectionString: BEHEER });
  await verwerkRonde(beheer, maakVerwerkers(beheer, middelen, new GeenZoekindex()), 1000);
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

test("registreren met origineel en html-weergave", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata, inhoud: docx("eerste export"), weergave: html("<h1>Nota</h1><p>Het Kenaupark krijgt nieuwe bomen.</p>") } });
  assert.equal(r.statusCode, 201, r.body);
  const o = r.json();
  id = o.identificatie;
  const v = o.versies[0];
  assert.equal(v.formaat, "docx");
  assert.equal(v.weergaven.length, 1);
  assert.equal(v.weergaven[0].formaat, "html");
  const origineel = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/inhoud`, headers: kop() });
  assert.equal(origineel.headers["x-oa-formaat"], "docx");
  assert.match(origineel.rawPayload.toString(), /eerste export/);
  const weergave = await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html`, headers: kop() });
  assert.equal(weergave.statusCode, 200);
  assert.match(weergave.body, /Kenaupark/);
  // Versleuteld opgeslagen, ook de weergave.
  for (const b of await readdir(join(map, "opslag", "haarlem", id))) {
    assert.ok(!(await readFile(join(map, "opslag", "haarlem", id, b))).toString("latin1").includes("Kenaupark"));
  }
});

test("een nieuwe export met dezelfde html is geen nieuwe versie", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: docx("tweede export, andere tijdstempel"), weergave: html("<h1>Nota</h1><p>Het Kenaupark krijgt nieuwe bomen.</p>") } });
  assert.equal(r.json().versies.length, 1);
});

test("gewijzigde html is een nieuwe versie", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: docx("derde"), weergave: html("<h1>Nota</h1><p>Het Kenaupark krijgt veertig nieuwe bomen.</p>") } });
  assert.equal(r.json().versies.length, 2);
});

test("een weergave in hetzelfde formaat als de versie mag niet; een onbekende weergave is 404", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: html("<p>x</p>"), weergave: html("<p>y</p>") } });
  assert.equal(r.statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/pdf`, headers: kop() })).statusCode, 404);
});

test("de zoekindex leest de html-weergave, niet het docx", { skip: overslaan }, async () => {
  await verwerkRonde(beheer, maakVerwerkers(beheer, middelen, new OpenSearchZoekindex(os.adres, "oa-w-")), 1000);
  assert.match(os.indexen.get("oa-w-haarlem").get(id).tekst, /veertig nieuwe bomen/);
});

test("zonder weergave werkt alles als vroeger", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata, inhoud: html("<p>Alleen html</p>") } });
  const v = r.json().versies[0];
  assert.equal(v.formaat, "html");
  assert.equal(v.weergaven, undefined);
});
