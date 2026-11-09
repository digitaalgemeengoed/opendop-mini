import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from "node:crypto";
import {
  PII_CATEGORIE,
  PII_SOORT,
  type Actor,
  type PiiCategorie,
  type PiiInvoer,
  type PiiOnthuld,
  type PiiRegister,
  type PiiRegistratie,
  type PiiSoort,
  type Ppl,
} from "@digitaalgemeengoed/oa-contract";
import type { Inhoud } from "@digitaalgemeengoed/oa-contract";
import type { Client } from "./db.js";
import { legGebeurtenisVast, leesInhoud, leesWeergave, PlatformFout, vergrendel, voegVersieToe, type Middelen, type ObjectMetStaat } from "./objecten.js";
import { SleutelVernietigd, type Deel } from "./sleutelbeheer.js";

/**
 * Het register van persoonsgegevens (anonimiseren bij de bron, zoals in de
 * MIRA-demo). In het document staan plaatshouders; hier staat per
 * plaatshouder de waarde, versleuteld met de sleutel van het document voor
 * die AVG-categorie. Wie het origineel wil zien, moet het niveau (PPL) van
 * die categorie hebben; elk inzien is een gebeurtenis.
 *
 *   c1  art. 6   AES-256-GCM
 *   c2  art. 9   ChaCha20-Poly1305
 *   c3  art. 10  RSA-OAEP (3072 bits, SHA-256) met een certificaat per
 *                document: het platform versleutelt met het publieke deel;
 *                de privésleutel is versleuteld bewaard en wordt alleen
 *                uitgepakt om in te zien. Lange waarden: RSA-OAEP verpakt
 *                een AES-sleutel (de gebruikelijke hybride vorm).
 */

const niveauVan = (a: Actor): Ppl => (a.niveau ?? 0) as Ppl;
const deel = (c: PiiCategorie): Deel => `pii-${c}` as Deel;
const sleutelnaam = (id: string, c: PiiCategorie) => `doc-${id.slice(0, 8)}-${c}`;

interface Sleutel {
  categorie: PiiCategorie;
  /** c1, c2: de datasleutel; c3: de datasleutel die de privésleutel beschermt. */
  dek: Buffer | null;
  publiek: string | null;
  prive: string | null;
}

function zonderSleutelbeheer(m: Middelen): never | void {
  if (!m.sleutelbeheer) throw new PlatformFout(503, "sleutelbeheer-uit", "Anonimiseren met versleuteling kan alleen met sleutelbeheer, en dat is hier niet ingesteld.");
}

function aead(algoritme: "aes-256-gcm" | "chacha20-poly1305", sleutel: Buffer, data: Buffer, binding: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(algoritme as "aes-256-gcm", sleutel, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(binding), { plaintextLength: data.length });
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function onAead(algoritme: "aes-256-gcm" | "chacha20-poly1305", sleutel: Buffer, blob: string, binding: string): Buffer {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv(algoritme as "aes-256-gcm", sleutel, b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(binding), { plaintextLength: b.length - 28 });
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

/** Haalt de sleutel van een categorie op, of maakt hem bij het eerste gebruik. */
async function sleutelVoor(c: Client, m: Middelen, gemeente: string, id: string, cat: PiiCategorie, uitpakken: boolean): Promise<Sleutel> {
  const r = await c.query("SELECT verpakt, publiek, prive, vernietigd FROM pii_sleutels WHERE object = $1 AND categorie = $2", [id, cat]);
  if (r.rowCount) {
    const rij = r.rows[0];
    if (rij.vernietigd) throw new PlatformFout(410, "pii-sleutel-vernietigd", `De sleutel voor ${PII_CATEGORIE[cat].omschrijving} van dit stuk is vernietigd.`);
    const dek = uitpakken ? await pakUit(m, gemeente, id, cat, rij.verpakt) : null;
    return { categorie: cat, dek, publiek: rij.publiek, prive: rij.prive };
  }
  const verpakt = await m.sleutelbeheer!.maakDeelsleutel(gemeente, id, deel(cat));
  const dek = await pakUit(m, gemeente, id, cat, verpakt);
  let publiek: string | null = null;
  let prive: string | null = null;
  if (cat === "c3") {
    const paar = generateKeyPairSync("rsa", { modulusLength: 3072 });
    publiek = paar.publicKey.export({ type: "spki", format: "pem" }).toString();
    prive = aead("aes-256-gcm", dek, Buffer.from(paar.privateKey.export({ type: "pkcs8", format: "pem" }).toString()), `${id}/c3/prive`);
  }
  await c.query("INSERT INTO pii_sleutels (object, gemeente, categorie, algoritme, verpakt, publiek, prive) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    id,
    gemeente,
    cat,
    PII_CATEGORIE[cat].algoritme,
    verpakt,
    publiek,
    prive,
  ]);
  return { categorie: cat, dek, publiek, prive };
}

async function pakUit(m: Middelen, gemeente: string, id: string, cat: PiiCategorie, verpakt: string): Promise<Buffer> {
  try {
    return await m.sleutelbeheer!.pakDeelUit(gemeente, id, deel(cat), verpakt);
  } catch (e) {
    if (e instanceof SleutelVernietigd) throw new PlatformFout(410, "pii-sleutel-vernietigd", `De sleutel voor ${PII_CATEGORIE[cat].omschrijving} van dit stuk is vernietigd.`);
    throw e;
  }
}

function versleutelWaarde(s: Sleutel, id: string, plaatshouder: string, waarde: string): string {
  const data = Buffer.from(waarde, "utf8");
  const binding = `${id}/${plaatshouder}`;
  if (s.categorie === "c1") return aead("aes-256-gcm", s.dek!, data, binding);
  if (s.categorie === "c2") return aead("chacha20-poly1305", s.dek!, data, binding);
  // c3: alleen het publieke deel nodig.
  const sleutel = randomBytes(32);
  const verpakt = publicEncrypt({ key: s.publiek!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, sleutel);
  return `${verpakt.toString("base64")}.${aead("aes-256-gcm", sleutel, data, binding)}`;
}

function ontsleutelWaarde(s: Sleutel, id: string, plaatshouder: string, blob: string): string {
  const binding = `${id}/${plaatshouder}`;
  if (s.categorie === "c1") return onAead("aes-256-gcm", s.dek!, blob, binding).toString("utf8");
  if (s.categorie === "c2") return onAead("chacha20-poly1305", s.dek!, blob, binding).toString("utf8");
  const prive = onAead("aes-256-gcm", s.dek!, s.prive!, `${id}/c3/prive`).toString();
  const [verpakt, rest] = blob.split(".");
  const sleutel = privateDecrypt({ key: prive, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(verpakt, "base64"));
  return onAead("aes-256-gcm", sleutel, rest, binding).toString("utf8");
}

const normaal = (w: string) => w.replace(/\s+/g, " ").trim();

/**
 * Registreert persoonsgegevens en geeft per invoer de plaatshouder terug.
 * Dezelfde waarde van dezelfde soort krijgt in een stuk altijd dezelfde
 * plaatshouder, ook in een latere ronde.
 */
export async function registreerPii(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  invoer: PiiInvoer[],
  voorvertoning = false,
): Promise<{ plaatshouder: string; soort: PiiSoort; categorie: PiiCategorie; nieuw: boolean }[]> {
  zonderSleutelbeheer(m);
  await vergrendel(c, id);
  if (!invoer.length) return [];
  const v = await c.query("SELECT COALESCE(max(nummer), 0) AS n FROM versies WHERE object = $1", [id]);
  const laatste = Number(v.rows[0].n);
  const c1 = await sleutelVoor(c, m, gemeente, id, "c1", true);
  const sleutels = new Map<PiiCategorie, Sleutel>([["c1", c1]]);
  const uit: { plaatshouder: string; soort: PiiSoort; categorie: PiiCategorie; nieuw: boolean }[] = [];
  const nieuwPer: Partial<Record<PiiCategorie, number>> = {};
  const tijd = new Date().toISOString();
  for (const i of invoer) {
    const info = PII_SOORT[i.soort];
    if (!info) throw new PlatformFout(400, "verzoek-ongeldig", `Onbekende soort: ${i.soort}`);
    const waarde = normaal(i.waarde);
    if (!waarde || waarde.length > 2000) throw new PlatformFout(400, "verzoek-ongeldig", "Een persoonsgegeven is leeg of te lang.");
    const zoek = createHmac("sha256", c1.dek!).update(`${i.soort}\0${waarde}`).digest("hex");
    const bestaand = await c.query("SELECT plaatshouder, categorie FROM pii_register WHERE object = $1 AND soort = $2 AND zoeksleutel = $3", [id, i.soort, zoek]);
    if (bestaand.rowCount) {
      uit.push({ plaatshouder: bestaand.rows[0].plaatshouder, soort: i.soort, categorie: bestaand.rows[0].categorie, nieuw: false });
      continue;
    }
    const cat = info.categorie;
    if (!sleutels.has(cat)) sleutels.set(cat, await sleutelVoor(c, m, gemeente, id, cat, cat !== "c3"));
    const s = sleutels.get(cat)!;
    // Het hoogste nummer plus één (een vervallen voorvertoning laat een gat, of geeft haar nummer vrij).
    const n = await c.query(
      `SELECT COALESCE(max((regexp_match(plaatshouder, ' ([0-9]+)\\]$'))[1]::int), 0) AS n FROM pii_register WHERE object = $1 AND plaatshouder LIKE $2`,
      [id, `[${info.plaatshouder} %`],
    );
    const plaatshouder = `[${info.plaatshouder} ${Number(n.rows[0].n) + 1}]`;
    await c.query(
      `INSERT INTO pii_register (object, gemeente, plaatshouder, soort, categorie, algoritme, cijfertekst, zoeksleutel, bron, versie, vastgelegd, door, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        gemeente,
        plaatshouder,
        i.soort,
        cat,
        PII_CATEGORIE[cat].algoritme,
        versleutelWaarde(s, id, plaatshouder, waarde),
        zoek,
        i.bron,
        laatste + 1,
        tijd,
        actor.sub,
        voorvertoning ? "voorvertoning" : "bevestigd",
      ],
    );
    nieuwPer[cat] = (nieuwPer[cat] ?? 0) + 1;
    uit.push({ plaatshouder, soort: i.soort, categorie: cat, nieuw: true });
  }
  if (Object.keys(nieuwPer).length && !voorvertoning) {
    // De versies tot nu toe bevatten deze gegevens nog leesbaar: alleen PPL 3.
    await beschermOriginelen(c, id, laatste);
    const g = await legGebeurtenisVast(c, gemeente, "pii.geregistreerd", id, actor, {
      nieuw: nieuwPer,
      plaatshouders: uit.filter((u) => u.nieuw).map((u) => u.plaatshouder),
    });
    await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  }
  return uit;
}

/** Versies tot en met `tot` bevatten de gegevens nog leesbaar: alleen PPL 3 mag ze lezen. */
async function beschermOriginelen(c: Client, id: string, tot: number): Promise<void> {
  await c.query("UPDATE versies SET ppl = 3 WHERE object = $1 AND nummer <= $2 AND ppl < 3", [id, tot]);
  await c.query("UPDATE objecten SET pii_tot_versie = GREATEST(COALESCE(pii_tot_versie, 0), $2) WHERE identificatie = $1", [id, tot]);
}

/** Voorvertoningen die de medewerker laat staan: uit het register. Bevestigde gegevens blijven. */
export async function vervallenPii(c: Client, id: string, actor: Actor, plaatshouders: string[]): Promise<PiiRegister> {
  await vergrendel(c, id);
  await c.query("DELETE FROM pii_register WHERE object = $1 AND plaatshouder = ANY($2) AND status = 'voorvertoning'", [id, plaatshouders]);
  return leesPiiRegister(c, id, actor);
}

/**
 * Bevestigen: de voorvertoningen die nog in het document staan worden
 * definitief, de andere vervallen. De versies tot en met de bronversie
 * bevatten de gegevens nog: die mag alleen PPL 3 lezen. Het geanonimiseerde
 * document wordt een nieuwe versie (soort anonimisering).
 */
export async function bevestigPii(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  v: { inhoud: Inhoud; weergave?: Inhoud; bronversie: number; behouden: string[] },
): Promise<ObjectMetStaat> {
  await vergrendel(c, id);
  const bron = await c.query("SELECT 1 FROM versies WHERE object = $1 AND nummer = $2", [id, v.bronversie]);
  if (!bron.rowCount) throw new PlatformFout(404, "versie-onbekend", `Versie ${v.bronversie} bestaat niet.`);
  await c.query("DELETE FROM pii_register WHERE object = $1 AND status = 'voorvertoning' AND NOT (plaatshouder = ANY($2))", [id, v.behouden]);
  const r = await c.query(
    "UPDATE pii_register SET status = 'bevestigd' WHERE object = $1 AND status = 'voorvertoning' AND plaatshouder = ANY($2) RETURNING plaatshouder, categorie",
    [id, v.behouden],
  );
  if (r.rowCount) {
    await beschermOriginelen(c, id, v.bronversie);
    const nieuw: Partial<Record<PiiCategorie, number>> = {};
    for (const x of r.rows) nieuw[x.categorie as PiiCategorie] = (nieuw[x.categorie as PiiCategorie] ?? 0) + 1;
    const g = await legGebeurtenisVast(c, gemeente, "pii.geregistreerd", id, actor, { nieuw, plaatshouders: r.rows.map((x) => x.plaatshouder), bronversie: v.bronversie });
    await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  }
  await c.query("UPDATE objecten SET ppl_werk = 0 WHERE identificatie = $1", [id]);
  return voegVersieToe(c, m, gemeente, actor, id, v.inhoud, undefined, v.weergave, { soort: "anonimisering", bronversie: v.bronversie, ppl: 0 });
}

/**
 * Bevestigde gegevens terugzetten in het document: geeft de waarden (binnen
 * het eigen niveau). Het werkdocument bevat ze daarna weer: volgende versies
 * vragen het niveau van die categorie.
 */
export async function terugzettenPii(c: Client, m: Middelen, gemeente: string, actor: Actor, id: string, plaatshouders: string[]): Promise<PiiOnthuld[]> {
  const waarden = await onthulPii(c, m, gemeente, actor, id, plaatshouders, "pii.teruggezet");
  const r = await c.query("SELECT COALESCE(max(CASE categorie WHEN 'c1' THEN 1 WHEN 'c2' THEN 2 ELSE 3 END), 0) AS n FROM pii_register WHERE object = $1 AND plaatshouder = ANY($2)", [
    id,
    plaatshouders,
  ]);
  await c.query("UPDATE objecten SET ppl_werk = GREATEST(ppl_werk, $2) WHERE identificatie = $1", [id, Number(r.rows[0].n)]);
  return waarden;
}

/**
 * Een eerdere versie terugzetten als nieuwe versie. Een versie met
 * persoonsgegevens: alleen met het niveau van die versie, en een reden.
 */
export async function zetVersieTerug(c: Client, m: Middelen, gemeente: string, actor: Actor, id: string, nummer: number, reden: string): Promise<ObjectMetStaat> {
  await vergrendel(c, id);
  await toetsVersieMetPii(c, id, nummer, actor);
  const v = await c.query("SELECT ppl FROM versies WHERE object = $1 AND nummer = $2", [id, nummer]);
  const ppl = Number(v.rows[0].ppl);
  const inhoud = await leesInhoud(c, m, gemeente, id, nummer);
  const w = await c.query("SELECT formaat FROM weergaven WHERE object = $1 AND nummer = $2 AND soort = 'weergave' LIMIT 1", [id, nummer]);
  const weergave = w.rowCount ? await leesWeergave(c, m, gemeente, id, nummer, w.rows[0].formaat) : null;
  const naarInhoud = (x: { data: Buffer; mediaType: string; formaat: string }): Inhoud => ({
    formaat: x.formaat as Inhoud["formaat"],
    mediaType: x.mediaType,
    codering: "base64",
    data: x.data.toString("base64"),
  });
  const g = await legGebeurtenisVast(c, gemeente, "versie.teruggezet", id, actor, { nummer, reden });
  await c.query("UPDATE objecten SET laatste_volgnummer = $2, ppl_werk = GREATEST(ppl_werk, $3) WHERE identificatie = $1", [id, g.volgnummer, ppl]);
  return voegVersieToe(c, m, gemeente, actor, id, naarInhoud(inhoud), undefined, weergave ? naarInhoud(weergave) : undefined, { soort: "terugzetting", bronversie: nummer, ppl });
}

export async function leesPiiRegister(c: Client, id: string, actor: Actor): Promise<PiiRegister> {
  const r = await c.query(
    `SELECT r.plaatshouder, r.soort, r.categorie, r.algoritme, r.bron, r.versie, r.vastgelegd, r.door, r.status, s.vernietigd
       FROM pii_register r LEFT JOIN pii_sleutels s ON s.object = r.object AND s.categorie = r.categorie
      WHERE r.object = $1 ORDER BY r.vastgelegd, r.plaatshouder`,
    [id],
  );
  const o = await c.query("SELECT max(nummer) AS tot FROM versies WHERE object = $1 AND ppl > 0", [id]);
  const registraties: PiiRegistratie[] = r.rows.map((x) => ({
    plaatshouder: x.plaatshouder,
    soort: x.soort,
    categorie: x.categorie,
    algoritme: x.algoritme,
    sleutel: sleutelnaam(id, x.categorie),
    bron: x.bron,
    versie: x.versie,
    vastgelegd: new Date(x.vastgelegd).toISOString(),
    door: x.door,
    ...(x.vernietigd ? { vernietigd: true } : {}),
    status: x.status,
  }));
  return { registraties, ...(o.rows[0]?.tot ? { metGegevensTot: o.rows[0].tot } : {}), niveau: niveauVan(actor) };
}

/** Originele waarden inzien, binnen het eigen niveau. Wordt vastgelegd (zonder de waarden). */
export async function onthulPii(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  plaatshouders: string[],
  gebeurtenis: "pii.ingezien" | "pii.teruggezet" = "pii.ingezien",
): Promise<PiiOnthuld[]> {
  zonderSleutelbeheer(m);
  const r = await c.query("SELECT plaatshouder, categorie, cijfertekst FROM pii_register WHERE object = $1 AND plaatshouder = ANY($2)", [id, plaatshouders]);
  if (r.rowCount !== new Set(plaatshouders).size) throw new PlatformFout(404, "pii-onbekend", "Een van de plaatshouders staat niet in het register van dit stuk.");
  const niveau = niveauVan(actor);
  for (const x of r.rows) {
    const nodig = PII_CATEGORIE[x.categorie as PiiCategorie].ppl;
    if (niveau < nodig) {
      throw new PlatformFout(403, "pii-niveau", `Je niveau (PPL ${niveau}) is te laag voor ${PII_CATEGORIE[x.categorie as PiiCategorie].omschrijving} (PPL ${nodig}).`);
    }
  }
  const sleutels = new Map<PiiCategorie, Sleutel>();
  const uit: PiiOnthuld[] = [];
  for (const x of r.rows) {
    const cat = x.categorie as PiiCategorie;
    if (!sleutels.has(cat)) sleutels.set(cat, await sleutelVoor(c, m, gemeente, id, cat, true));
    uit.push({ plaatshouder: x.plaatshouder, waarde: ontsleutelWaarde(sleutels.get(cat)!, id, x.plaatshouder, x.cijfertekst) });
  }
  const g = await legGebeurtenisVast(c, gemeente, gebeurtenis, id, actor, { plaatshouders: uit.map((u) => u.plaatshouder) });
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  return uit;
}

/** De sleutel van één categorie vernietigen: die waarden zijn daarna voor niemand meer te lezen. */
export async function vernietigPii(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  cat: PiiCategorie,
  reden: string,
  originelen: "laten" | "beperken" = "laten",
): Promise<PiiRegister> {
  zonderSleutelbeheer(m);
  await vergrendel(c, id);
  const r = await c.query("UPDATE pii_sleutels SET vernietigd = now() WHERE object = $1 AND categorie = $2 AND vernietigd IS NULL RETURNING 1", [id, cat]);
  if (!r.rowCount) throw new PlatformFout(404, "pii-sleutel-onbekend", "Dit stuk heeft geen (werkende) sleutel voor deze categorie.");
  // De originele versies zijn archiefstukken: vernietigen kan alleen via het vernietigingsproces. Wel kan de toegang omlaag.
  if (originelen === "beperken") await c.query("UPDATE versies SET beperkt = true WHERE object = $1 AND ppl > 0", [id]);
  const g = await legGebeurtenisVast(c, gemeente, "pii.vernietigd", id, actor, { categorie: cat, reden, originelen });
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  // Eerst vastleggen, dan vernietigen: lukt dat niet, dan rolt de transactie terug.
  await m.sleutelbeheer!.vernietigDeel(gemeente, id, deel(cat));
  return leesPiiRegister(c, id, actor);
}

/**
 * Een versie die persoonsgegevens bevat, mag alleen lezen wie het niveau van
 * die versie heeft; een beperkte versie alleen informatiebeheer.
 */
export async function toetsVersieMetPii(c: Client, id: string, nummer: number, actor: Actor): Promise<void> {
  const r = await c.query("SELECT ppl, beperkt FROM versies WHERE object = $1 AND nummer = $2", [id, nummer]);
  if (!r.rowCount) return; // bestaat niet: dat meldt de lezer zelf
  const { ppl, beperkt } = r.rows[0];
  if (beperkt && !actor.beheerder) {
    throw new PlatformFout(403, "versie-beperkt", `Versie ${nummer} bevat persoonsgegevens en is alleen nog in te zien voor informatiebeheer.`);
  }
  if (niveauVan(actor) < Number(ppl)) {
    throw new PlatformFout(403, "pii-versie", `Versie ${nummer} bevat persoonsgegevens. Daarvoor is PPL ${ppl} nodig; je hebt PPL ${niveauVan(actor)}.`);
  }
}
