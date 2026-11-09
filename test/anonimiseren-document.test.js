// Anonimiseren in het document (migratie 007): voorvertoningen in het
// register, bevestigen als nieuwe versie, het niveau per versie, terugzetten
// per gegeven of de hele versie, en beperken van de originelen.
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

const kop = (niveau = 1, beheerder = false) => ({
  "x-oa-dienstsleutel": SLEUTEL,
  "x-oa-gemeente": "haarlem",
  "x-oa-actor": Buffer.from(JSON.stringify({ sub: "ad-1", naam: "ad-1", niveau, beheerder })).toString("base64url"),
});
const html = (s) => ({ formaat: "html", mediaType: "text/html", codering: "tekst", data: s });

before(async () => {
  if (overslaan) return;
  await migreer(BEHEER, { gemeenten: [{ id: "haarlem", naam: "Gemeente Haarlem" }] });
  try { huidigePool(); } catch { maakPool(APP); }
  map = await mkdtemp(join(tmpdir(), "oa-ad-"));
  const middelen = { opslag: new LokaleOpslag(join(map, "opslag")), sleutelbeheer: new LokaalSleutelbeheer(join(map, "sleutels")), maxBytes: 1024 * 1024 };
  app = bouwServer({ middelen, zoekindex: new GeenZoekindex(), dienstsleutel: SLEUTEL, log: false });
});

after(async () => {
  if (overslaan) return;
  await app.close();
  await huidigePool().end();
  await rm(map, { recursive: true, force: true });
});

let id;
const vraag = (method, pad, payload, k = kop()) => app.inject({ method, url: `/objecten/${id}${pad}`, headers: k, payload });
const object = async () => (await vraag("GET", "")).json();
const leesVersie = (n, k) => vraag("GET", `/versies/${n}/inhoud`, undefined, k);

test("voorvertoning: geregistreerd met vast nummer, nog geen gebeurtenis, originelen nog vrij", { skip: overslaan }, async () => {
  const r = await app.inject({ method: "POST", url: "/objecten", headers: kop(), payload: { objecttype: "document", metadata: { naam: "Brief" }, inhoud: html("<p>Mevrouw Van Dalen, Weidevaartpad 12, slaapstoornis.</p>") } });
  id = r.json().identificatie;
  const a = await vraag("POST", "/pii", {
    voorvertoning: true,
    items: [
      { soort: "naam", waarde: "Van Dalen", bron: "model" },
      { soort: "adres", waarde: "Weidevaartpad 12", bron: "patroon" },
      { soort: "gezondheid", waarde: "slaapstoornis", bron: "medewerker" },
    ],
  });
  assert.equal(a.statusCode, 201, a.body);
  assert.deepEqual(a.json().plaatshouders.map((p) => p.plaatshouder), ["[PERSOON 1]", "[ADRES 1]", "[GEZONDHEID 1]"]);
  const reg = (await vraag("GET", "/pii")).json();
  assert.deepEqual(reg.registraties.map((x) => x.status), ["voorvertoning", "voorvertoning", "voorvertoning"]);
  const g = (await vraag("GET", "/gebeurtenissen")).json();
  assert.equal(g.filter((x) => x.type.startsWith("pii.")).length, 0);
  assert.equal((await leesVersie(1, kop(0))).statusCode, 200);
});

test("laat staan: een voorvertoning vervalt en haar nummer komt vrij", { skip: overslaan }, async () => {
  const r = await vraag("POST", "/pii/vervallen", { plaatshouders: ["[ADRES 1]"] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().registraties.map((x) => x.plaatshouder).sort(), ["[GEZONDHEID 1]", "[PERSOON 1]"]);
  const b = await vraag("POST", "/pii", { voorvertoning: true, items: [{ soort: "adres", waarde: "Kruisweg 1", bron: "medewerker" }, { soort: "naam", waarde: "Jan", bron: "model" }] });
  assert.deepEqual(b.json().plaatshouders.map((p) => p.plaatshouder), ["[ADRES 1]", "[PERSOON 2]"]);
});

test("bevestigen: definitief, de rest vervalt, nieuwe versie; het origineel alleen voor PPL 3", { skip: overslaan }, async () => {
  const r = await vraag("POST", "/pii/bevestig", {
    inhoud: html("<p>Mevrouw [PERSOON 1], [ADRES 1], [GEZONDHEID 1].</p>"),
    bronversie: 1,
    behouden: ["[PERSOON 1]", "[ADRES 1]", "[GEZONDHEID 1]"],
  });
  assert.equal(r.statusCode, 201, r.body);
  const v = r.json().versies;
  assert.deepEqual(
    v.map((x) => [x.nummer, x.soort ?? "gewoon", x.bronversie ?? null, x.ppl ?? 0]),
    [[1, "gewoon", null, 3], [2, "anonimisering", 1, 0]],
  );
  const reg = (await vraag("GET", "/pii")).json();
  assert.deepEqual(reg.registraties.map((x) => [x.plaatshouder, x.status]).sort(), [["[ADRES 1]", "bevestigd"], ["[GEZONDHEID 1]", "bevestigd"], ["[PERSOON 1]", "bevestigd"]]);
  assert.equal(reg.metGegevensTot, 1);
  const g = (await vraag("GET", "/gebeurtenissen")).json().find((x) => x.type === "pii.geregistreerd");
  assert.deepEqual(g.gegevens.nieuw, { c1: 2, c2: 1 });
  assert.equal(g.gegevens.bronversie, 1);
  assert.equal((await leesVersie(1, kop(2))).statusCode, 403);
  assert.equal((await leesVersie(1, kop(3))).statusCode, 200);
  assert.equal((await leesVersie(2, kop(0))).statusCode, 200);
  // Bevestigde gegevens vervallen niet.
  await vraag("POST", "/pii/vervallen", { plaatshouders: ["[PERSOON 1]"] });
  assert.equal((await vraag("GET", "/pii")).json().registraties.length, 3);
});

test("terugzetten per gegeven: binnen het niveau, en de volgende versie vraagt dat niveau", { skip: overslaan }, async () => {
  assert.equal((await vraag("POST", "/pii/terugzetten", { plaatshouders: ["[PERSOON 1]"] }, kop(0))).statusCode, 403);
  const r = await vraag("POST", "/pii/terugzetten", { plaatshouders: ["[PERSOON 1]"] }, kop(1));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().waarden, [{ plaatshouder: "[PERSOON 1]", waarde: "Van Dalen" }]);
  const v = await vraag("POST", "/versies", { inhoud: html("<p>Mevrouw Van Dalen, [ADRES 1], [GEZONDHEID 1].</p>") });
  assert.equal(v.json().versies.at(-1).ppl, 1);
  assert.equal((await leesVersie(3, kop(0))).statusCode, 403);
  assert.equal((await leesVersie(3, kop(1))).statusCode, 200);
  assert.ok((await vraag("GET", "/gebeurtenissen")).json().some((x) => x.type === "pii.teruggezet"));
});

test("terugzetten van een hele versie: het niveau van die versie, een reden, als nieuwe versie", { skip: overslaan }, async () => {
  assert.equal((await vraag("POST", "/versies/1/terugzetten", { reden: "Verkeerd geanonimiseerd" }, kop(2))).statusCode, 403);
  assert.equal((await vraag("POST", "/versies/1/terugzetten", { reden: "kort" }, kop(3))).statusCode, 400);
  const r = await vraag("POST", "/versies/1/terugzetten", { reden: "Verkeerd geanonimiseerd" }, kop(3));
  assert.equal(r.statusCode, 201, r.body);
  const laatste = r.json().versies.at(-1);
  assert.deepEqual([laatste.nummer, laatste.soort, laatste.bronversie, laatste.ppl], [4, "terugzetting", 1, 3]);
  assert.equal(Buffer.from((await leesVersie(4, kop(3))).rawPayload).toString(), "<p>Mevrouw Van Dalen, Weidevaartpad 12, slaapstoornis.</p>");
  assert.ok((await vraag("GET", "/gebeurtenissen")).json().some((x) => x.type === "versie.teruggezet" && x.gegevens.reden === "Verkeerd geanonimiseerd"));
});

test("vernietigen met beperken: de originelen alleen nog voor informatiebeheer", { skip: overslaan }, async () => {
  const r = await vraag("POST", "/pii/vernietig", { categorie: "c2", reden: "Bewaartermijn verstreken", originelen: "beperken" }, kop(3, true));
  assert.equal(r.statusCode, 200, r.body);
  const v = (await object()).versies;
  assert.deepEqual(v.map((x) => [x.nummer, !!x.beperkt]), [[1, true], [2, false], [3, true], [4, true]]);
  const geweigerd = await leesVersie(1, kop(3));
  assert.equal(geweigerd.statusCode, 403);
  assert.equal(geweigerd.json().fout, "versie-beperkt");
  assert.equal((await leesVersie(1, kop(3, true))).statusCode, 200);
  assert.equal((await leesVersie(2, kop(0))).statusCode, 200);
});
