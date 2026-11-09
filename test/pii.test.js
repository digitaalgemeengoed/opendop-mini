// Register van persoonsgegevens (migratie 006): plaatshouders, versleuteld
// per document per AVG-categorie, inzien per PPL-niveau, eerdere versies
// alleen voor PPL 3, vernietigen per categorie.
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

const kop = (sub = "p-1", niveau = 1) => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": "haarlem",
  "x-oa-actor": Buffer.from(JSON.stringify({ sub, naam: sub, niveau })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });
const docx = (s) => ({ formaat: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", codering: "base64", data: Buffer.from(`PK\u0003\u0004 ${s}`).toString("base64") });
const verwerk = () => verwerkRonde(beheer, maakVerwerkers(beheer, middelen, zoekindex), 1000);
const zoek = async (tekst, sub) => (await app.inject({ method: "GET", url: `/zoeken?tekst=${encodeURIComponent(tekst)}`, headers: kop(sub) })).json();

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-pii-"));
  os = await startNepOpenSearch();
  zoekindex = new OpenSearchZoekindex(os.adres, "oa-pi-");
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
const pii = (items, sub, niveau) => app.inject({ method: "POST", url: `/objecten/${id}/pii`, headers: kop(sub, niveau), payload: { items } });
const onthul = (plaatshouders, niveau, sub = "p-1") => app.inject({ method: "POST", url: `/objecten/${id}/pii/onthul`, headers: kop(sub, niveau), payload: { plaatshouders } });

test("registreren: plaatshouders per soort, dezelfde waarde dezelfde plaatshouder", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: { naam: "Besluit" }, inhoud: docx("v1"), weergave: html("<p>Mevrouw Van Dalen (Weidevaartpad 12) vreest overlast, mede vanwege haar slaapstoornis.</p>") } });
  assert.equal(r.statusCode, 201, r.body);
  id = r.json().identificatie;
  const a = await pii([
    { soort: "naam", waarde: "Van Dalen", bron: "model" },
    { soort: "adres", waarde: "Weidevaartpad 12", bron: "patroon" },
    { soort: "gezondheid", waarde: "haar slaapstoornis", bron: "medewerker" },
    { soort: "strafrechtelijk", waarde: "eerder veroordeeld voor " + "x".repeat(600), bron: "medewerker" },
    { soort: "naam", waarde: "P. Yilmaz", bron: "model" },
  ]);
  assert.equal(a.statusCode, 201, a.body);
  assert.deepEqual(a.json().plaatshouders.map((p) => [p.plaatshouder, p.categorie]), [["[PERSOON 1]", "c1"], ["[ADRES 1]", "c1"], ["[GEZONDHEID 1]", "c2"], ["[STRAFRECHTELIJK 1]", "c3"], ["[PERSOON 2]", "c1"]]);
  const b = await pii([{ soort: "naam", waarde: "  Van   Dalen ", bron: "medewerker" }, { soort: "naam", waarde: "Klaas Bakker", bron: "model" }]);
  assert.deepEqual(b.json().plaatshouders.map((p) => [p.plaatshouder, p.nieuw]), [["[PERSOON 1]", false], ["[PERSOON 3]", true]]);
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json();
  const reg = g.filter((x) => x.type === "pii.geregistreerd");
  assert.deepEqual(reg[0].gegevens.nieuw, { c1: 3, c2: 1, c3: 1 });
  assert.ok(!JSON.stringify(g).includes("Dalen"), "geen waarden in de gebeurtenissen");
});

test("het register: zonder waarden, met algoritme en sleutel per categorie", { skip: overslaan }, async () => {
  const r = (await app.inject({ method: "GET", url: `/objecten/${id}/pii`, headers: kop() })).json();
  assert.equal(r.niveau, 1);
  assert.equal(r.metGegevensTot, 1);
  const per = Object.fromEntries(r.registraties.map((x) => [x.plaatshouder, `${x.algoritme} ${x.sleutel}`]));
  assert.equal(per["[PERSOON 1]"], `AES-256-GCM doc-${id.slice(0, 8)}-c1`);
  assert.equal(per["[GEZONDHEID 1]"], `ChaCha20-Poly1305 doc-${id.slice(0, 8)}-c2`);
  assert.equal(per["[STRAFRECHTELIJK 1]"], `RSA-OAEP doc-${id.slice(0, 8)}-c3`);
  assert.ok(!JSON.stringify(r).includes("Dalen"));
  const rij = await beheer.query("SELECT cijfertekst FROM pii_register WHERE object = $1", [id]);
  assert.ok(rij.rows.every((x) => !x.cijfertekst.includes("Dalen")));
});

test("inzien per niveau; elk inzien is een gebeurtenis", { skip: overslaan }, async () => {
  const r1 = await onthul(["[PERSOON 1]", "[ADRES 1]"], 1);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.deepEqual(r1.json().waarden, [{ plaatshouder: "[ADRES 1]", waarde: "Weidevaartpad 12" }, { plaatshouder: "[PERSOON 1]", waarde: "Van Dalen" }].sort((a, b) => r1.json().waarden.findIndex((x) => x.plaatshouder === a.plaatshouder) - r1.json().waarden.findIndex((x) => x.plaatshouder === b.plaatshouder)));
  const r0 = await onthul(["[PERSOON 1]"], 0);
  assert.equal(r0.statusCode, 403);
  assert.equal((await onthul(["[GEZONDHEID 1]"], 1)).statusCode, 403);
  const r2 = await onthul(["[GEZONDHEID 1]"], 2);
  assert.equal(r2.json().waarden[0].waarde, "haar slaapstoornis");
  assert.equal((await onthul(["[STRAFRECHTELIJK 1]"], 2)).statusCode, 403);
  const r3 = await onthul(["[STRAFRECHTELIJK 1]"], 3);
  assert.match(r3.json().waarden[0].waarde, /^eerder veroordeeld voor x{600}$/);
  const g = (await app.inject({ method: "GET", url: `/objecten/${id}/gebeurtenissen`, headers: kop() })).json().filter((x) => x.type === "pii.ingezien");
  assert.equal(g.length, 3);
  assert.equal(g[0].actor.niveau, 1);
});

test("eerdere versies alleen voor PPL 3; de nieuwe versie voor iedereen", { skip: overslaan }, async () => {
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html`, headers: kop("p-1", 2) })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}/versies/1/weergaven/html`, headers: kop("p-1", 3) })).statusCode, 200);
  const v = await app.inject({ method: "POST", url: `/objecten/${id}/versies`, headers: kop(), payload: { inhoud: docx("v2"), weergave: html("<p>Mevrouw [PERSOON 1] ([ADRES 1]) vreest overlast, mede vanwege [GEZONDHEID 1].</p>") } });
  assert.equal(v.statusCode, 201, v.body);
  assert.equal((await app.inject({ method: "GET", url: `/objecten/${id}/versies/2/weergaven/html`, headers: kop("p-1", 0) })).statusCode, 200);
});

test("vernietigen per categorie: die waarden onleesbaar, de rest niet", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: `/objecten/${id}/pii/vernietig`, headers: kop("p-1", 3), payload: { categorie: "c2", reden: "Bewaartermijn bijzondere gegevens verstreken" } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().registraties.find((x) => x.plaatshouder === "[GEZONDHEID 1]").vernietigd);
  assert.equal((await onthul(["[GEZONDHEID 1]"], 3)).statusCode, 410);
  assert.equal((await onthul(["[PERSOON 1]"], 3)).statusCode, 200);
  const nieuw = await pii([{ soort: "religie", waarde: "katholiek", bron: "medewerker" }]);
  assert.equal(nieuw.statusCode, 410);
});
