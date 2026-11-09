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
import type { Client } from "./db.js";
import { legGebeurtenisVast, PlatformFout, vergrendel, type Middelen } from "./objecten.js";
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
    const n = await c.query("SELECT count(*) AS n FROM pii_register WHERE object = $1 AND plaatshouder LIKE $2", [id, `[${info.plaatshouder} %`]);
    const plaatshouder = `[${info.plaatshouder} ${Number(n.rows[0].n) + 1}]`;
    await c.query(
      `INSERT INTO pii_register (object, gemeente, plaatshouder, soort, categorie, algoritme, cijfertekst, zoeksleutel, bron, versie, vastgelegd, door)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, gemeente, plaatshouder, i.soort, cat, PII_CATEGORIE[cat].algoritme, versleutelWaarde(s, id, plaatshouder, waarde), zoek, i.bron, laatste + 1, tijd, actor.sub],
    );
    nieuwPer[cat] = (nieuwPer[cat] ?? 0) + 1;
    uit.push({ plaatshouder, soort: i.soort, categorie: cat, nieuw: true });
  }
  if (Object.keys(nieuwPer).length) {
    // De versies tot nu toe bevatten deze gegevens nog leesbaar.
    await c.query("UPDATE objecten SET pii_tot_versie = GREATEST(COALESCE(pii_tot_versie, 0), $2) WHERE identificatie = $1", [id, laatste]);
    const g = await legGebeurtenisVast(c, gemeente, "pii.geregistreerd", id, actor, {
      nieuw: nieuwPer,
      plaatshouders: uit.filter((u) => u.nieuw).map((u) => u.plaatshouder),
    });
    await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  }
  return uit;
}

export async function leesPiiRegister(c: Client, id: string, actor: Actor): Promise<PiiRegister> {
  const r = await c.query(
    `SELECT r.plaatshouder, r.soort, r.categorie, r.algoritme, r.bron, r.versie, r.vastgelegd, r.door, s.vernietigd
       FROM pii_register r LEFT JOIN pii_sleutels s ON s.object = r.object AND s.categorie = r.categorie
      WHERE r.object = $1 ORDER BY r.vastgelegd, r.plaatshouder`,
    [id],
  );
  const o = await c.query("SELECT pii_tot_versie FROM objecten WHERE identificatie = $1", [id]);
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
  }));
  return { registraties, ...(o.rows[0]?.pii_tot_versie ? { metGegevensTot: o.rows[0].pii_tot_versie } : {}), niveau: niveauVan(actor) };
}

/** Originele waarden inzien, binnen het eigen niveau. Wordt vastgelegd (zonder de waarden). */
export async function onthulPii(c: Client, m: Middelen, gemeente: string, actor: Actor, id: string, plaatshouders: string[]): Promise<PiiOnthuld[]> {
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
  const g = await legGebeurtenisVast(c, gemeente, "pii.ingezien", id, actor, { plaatshouders: uit.map((u) => u.plaatshouder) });
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  return uit;
}

/** De sleutel van één categorie vernietigen: die waarden zijn daarna voor niemand meer te lezen. */
export async function vernietigPii(c: Client, m: Middelen, gemeente: string, actor: Actor, id: string, cat: PiiCategorie, reden: string): Promise<PiiRegister> {
  zonderSleutelbeheer(m);
  await vergrendel(c, id);
  const r = await c.query("UPDATE pii_sleutels SET vernietigd = now() WHERE object = $1 AND categorie = $2 AND vernietigd IS NULL RETURNING 1", [id, cat]);
  if (!r.rowCount) throw new PlatformFout(404, "pii-sleutel-onbekend", "Dit stuk heeft geen (werkende) sleutel voor deze categorie.");
  const g = await legGebeurtenisVast(c, gemeente, "pii.vernietigd", id, actor, { categorie: cat, reden });
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  // Eerst vastleggen, dan vernietigen: lukt dat niet, dan rolt de transactie terug.
  await m.sleutelbeheer!.vernietigDeel(gemeente, id, deel(cat));
  return leesPiiRegister(c, id, actor);
}

/** Een versie van vóór het anonimiseren bevat de gegevens nog: alleen PPL 3 mag die lezen. */
export async function toetsVersieMetPii(c: Client, id: string, nummer: number, actor: Actor): Promise<void> {
  const r = await c.query("SELECT pii_tot_versie FROM objecten WHERE identificatie = $1", [id]);
  const tot = r.rows[0]?.pii_tot_versie;
  if (tot && nummer <= tot && niveauVan(actor) < 3) {
    throw new PlatformFout(403, "pii-versie", `Versie ${nummer} is van vóór het anonimiseren en bevat de persoonsgegevens nog. Alleen wie PPL 3 heeft, mag die lezen.`);
  }
}
