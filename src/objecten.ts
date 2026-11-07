import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  Gebeurtenis,
  Gebeurtenistype,
  Inhoud,
  Informatieobject,
  Objecttype,
  Versie,
} from "@digitaalgemeengoed/oa-contract";
import type { Client } from "./db.js";
import type { Opslag } from "./opslag.js";
import { ontsleutel, SleutelVernietigd, versleutel, type Sleutelbeheer } from "./sleutelbeheer.js";
import { schemaBruikbaar, toets, type Toetsing } from "./validatie.js";

export class PlatformFout extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    melding: string,
    readonly details?: unknown,
  ) {
    super(melding);
  }
}

export interface ObjectMetStaat extends Informatieobject {
  volgnummer: number;
  volledigheid: { volledig: boolean; ontbreekt: string[] };
}

// ---------------------------------------------------------------------------
// Gebeurtenissen
// ---------------------------------------------------------------------------

async function legGebeurtenisVast(
  c: Client,
  gemeente: string,
  type: Gebeurtenistype,
  objectId: string | null,
  actor: Actor,
  gegevens: Record<string, unknown>,
): Promise<{ volgnummer: number; tijdstip: string }> {
  const r = await c.query(
    `INSERT INTO gebeurtenissen (id, type, gemeente, object_id, actor, gegevens)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING volgnummer, tijdstip`,
    [randomUUID(), type, gemeente, objectId, actor, gegevens],
  );
  return { volgnummer: Number(r.rows[0].volgnummer), tijdstip: r.rows[0].tijdstip.toISOString() };
}

async function zetInOutbox(c: Client, gemeente: string, volgnummer: number, taak: string): Promise<void> {
  await c.query("INSERT INTO outbox (gemeente, volgnummer, taak) VALUES ($1, $2, $3)", [gemeente, volgnummer, taak]);
}

export async function leesGebeurtenissen(c: Client, objectId: string): Promise<Gebeurtenis[]> {
  const r = await c.query(
    `SELECT id, volgnummer, type, gemeente, object_id, actor, tijdstip, gegevens
       FROM gebeurtenissen WHERE object_id = $1 ORDER BY volgnummer`,
    [objectId],
  );
  return r.rows.map((g) => ({
    id: g.id,
    volgnummer: Number(g.volgnummer),
    type: g.type,
    gemeente: g.gemeente,
    objectId: g.object_id,
    actor: g.actor,
    tijdstip: g.tijdstip.toISOString(),
    gegevens: g.gegevens,
  }));
}

// ---------------------------------------------------------------------------
// Objecttypen
// ---------------------------------------------------------------------------

function naarObjecttype(r: Record<string, any>): Objecttype {
  return {
    naam: r.naam,
    versie: r.versie,
    titel: r.titel,
    schema: r.schema,
    status: r.status,
    vervaldatum: r.vervaldatum ? r.vervaldatum.toISOString().slice(0, 10) : null,
  };
}

/** Het actieve objecttype; een eigen type van de gemeente gaat voor het gedeelde. */
export async function leesObjecttype(c: Client, naam: string, versie?: number): Promise<Objecttype> {
  const r = versie
    ? await c.query(
        `SELECT * FROM objecttypen WHERE naam = $1 AND versie = $2
          ORDER BY (gemeente = '*') ASC LIMIT 1`,
        [naam, versie],
      )
    : await c.query(
        `SELECT * FROM objecttypen WHERE naam = $1 AND status = 'actief'
          ORDER BY (gemeente = '*') ASC, versie DESC LIMIT 1`,
        [naam],
      );
  if (r.rowCount === 0) throw new PlatformFout(404, "objecttype-onbekend", `Objecttype ${naam} bestaat niet of is niet actief.`);
  return naarObjecttype(r.rows[0]);
}

export async function lijstObjecttypen(c: Client): Promise<Objecttype[]> {
  const r = await c.query(
    `SELECT DISTINCT ON (naam) * FROM objecttypen WHERE status = 'actief'
      ORDER BY naam, (gemeente = '*') ASC, versie DESC`,
  );
  return r.rows.map(naarObjecttype);
}

export async function publiceerObjecttype(
  c: Client,
  gemeente: string,
  actor: Actor,
  type: Omit<Objecttype, "versie" | "status"> & { status?: "concept" | "actief" },
): Promise<Objecttype> {
  const fout = schemaBruikbaar(type.schema);
  if (fout) throw new PlatformFout(422, "schema-onbruikbaar", "Het schema is geen geldig JSON Schema.", fout);
  const r = await c.query(`SELECT COALESCE(MAX(versie), 0) + 1 AS v FROM objecttypen WHERE naam = $1`, [type.naam]);
  const versie = Number(r.rows[0].v);
  const status = type.status ?? "actief";
  await c.query(
    `INSERT INTO objecttypen (gemeente, naam, versie, titel, schema, status, vervaldatum)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [gemeente, type.naam, versie, type.titel, type.schema, status, type.vervaldatum ?? null],
  );
  await legGebeurtenisVast(c, gemeente, "objecttype.gepubliceerd", null, actor, { naam: type.naam, versie, status });
  return { ...type, versie, status, vervaldatum: type.vervaldatum ?? null };
}

// ---------------------------------------------------------------------------
// Informatieobjecten
// ---------------------------------------------------------------------------

function weigerOngeldig(t: Toetsing): void {
  if (!t.geldig) throw new PlatformFout(422, "metadata-ongeldig", "De metadata klopt niet met het objecttype.", t.fouten);
}

export async function leesObject(c: Client, id: string): Promise<ObjectMetStaat> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PlatformFout(404, "object-onbekend", "Dit object bestaat niet.");
  const r = await c.query("SELECT * FROM objecten WHERE identificatie = $1", [id]);
  if (r.rowCount === 0) throw new PlatformFout(404, "object-onbekend", "Dit object bestaat niet.");
  const o = r.rows[0];
  const v = await c.query("SELECT * FROM versies WHERE object = $1 ORDER BY nummer", [id]);
  const type = await leesObjecttype(c, o.objecttype_naam, o.objecttype_versie);
  const t = toets(`${type.naam}@${type.versie}`, type.schema, o.metadata);
  return {
    identificatie: o.identificatie,
    gemeente: o.gemeente,
    objecttype: { naam: o.objecttype_naam, versie: o.objecttype_versie },
    metadata: o.metadata,
    versies: v.rows.map(
      (x): Versie => ({
        nummer: x.nummer,
        sha256: x.sha256,
        grootte: Number(x.grootte),
        mediaType: x.media_type,
        formaat: x.formaat,
        vastgelegd: x.vastgelegd.toISOString(),
        door: x.door,
      }),
    ),
    aangemaakt: o.aangemaakt.toISOString(),
    aangemaaktDoor: o.aangemaakt_door,
    versleuteld: o.versleuteld,
    onleesbaarGemaakt: o.onleesbaar_gemaakt ? o.onleesbaar_gemaakt.toISOString() : null,
    volgnummer: Number(o.laatste_volgnummer),
    volledigheid: { volledig: t.ontbreekt.length === 0, ontbreekt: t.ontbreekt },
  };
}


/** Wat de objectlogica van buiten nodig heeft. */
export interface Middelen {
  opslag: Opslag;
  /** null = inhoud wordt niet versleuteld. */
  sleutelbeheer: Sleutelbeheer | null;
  maxBytes: number;
}

export async function maakObject(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  vraag: { objecttype: string; metadata?: Record<string, unknown>; inhoud?: Inhoud },
): Promise<ObjectMetStaat> {
  const type = await leesObjecttype(c, vraag.objecttype);
  const metadata = vraag.metadata ?? {};
  const t = toets(`${type.naam}@${type.versie}`, type.schema, metadata);
  weigerOngeldig(t);

  const id = randomUUID();
  // De sleutel bestaat vóór de registratie; mislukt de transactie, dan blijft
  // hooguit een ongebruikte sleutel achter.
  const verpakt = m.sleutelbeheer ? await m.sleutelbeheer.maakObjectsleutel(gemeente, id) : null;
  const g = await legGebeurtenisVast(c, gemeente, "object.aangemaakt", id, actor, {
    objecttype: { naam: type.naam, versie: type.versie },
    metadata,
    versleuteld: verpakt !== null,
  });
  await c.query(
    `INSERT INTO objecten (identificatie, gemeente, objecttype_naam, objecttype_versie, metadata,
                           laatste_volgnummer, aangemaakt, aangemaakt_door, versleuteld, sleutel_verpakt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, gemeente, type.naam, type.versie, metadata, g.volgnummer, g.tijdstip, actor.sub, verpakt !== null, verpakt],
  );
  await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  if (vraag.inhoud) await voegVersieToe(c, m, gemeente, actor, id, vraag.inhoud);
  return leesObject(c, id);
}

async function vergrendel(c: Client, id: string, verwacht?: number): Promise<{ versleuteld: boolean; verpakt: string | null; onleesbaar: boolean }> {
  const r = await c.query(
    "SELECT laatste_volgnummer, versleuteld, sleutel_verpakt, onleesbaar_gemaakt FROM objecten WHERE identificatie = $1 FOR UPDATE",
    [id],
  );
  if (r.rowCount === 0) throw new PlatformFout(404, "object-onbekend", "Dit object bestaat niet.");
  const huidig = Number(r.rows[0].laatste_volgnummer);
  if (verwacht !== undefined && verwacht !== huidig) {
    throw new PlatformFout(409, "object-gewijzigd", "Het object is intussen gewijzigd. Laad de nieuwste stand.", {
      verwacht,
      huidig,
    });
  }
  return { versleuteld: r.rows[0].versleuteld, verpakt: r.rows[0].sleutel_verpakt, onleesbaar: !!r.rows[0].onleesbaar_gemaakt };
}

export async function legMetadataVast(
  c: Client,
  gemeente: string,
  actor: Actor,
  id: string,
  metadata: Record<string, unknown>,
  verwachteVolgnummer?: number,
): Promise<ObjectMetStaat> {
  await vergrendel(c, id, verwachteVolgnummer);
  const huidig = await leesObject(c, id);
  const type = await leesObjecttype(c, huidig.objecttype.naam, huidig.objecttype.versie);
  weigerOngeldig(toets(`${type.naam}@${type.versie}`, type.schema, metadata));

  const gewijzigd = Object.keys({ ...huidig.metadata, ...metadata }).filter(
    (k) => JSON.stringify(huidig.metadata[k]) !== JSON.stringify(metadata[k]),
  );
  if (gewijzigd.length === 0) return huidig;

  const g = await legGebeurtenisVast(c, gemeente, "metadata.vastgelegd", id, actor, { metadata, gewijzigd });
  await c.query("UPDATE objecten SET metadata = $2, laatste_volgnummer = $3 WHERE identificatie = $1", [
    id,
    metadata,
    g.volgnummer,
  ]);
  await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  return leesObject(c, id);
}

export function decodeer(inhoud: Inhoud, maxBytes: number): Buffer {
  const data = inhoud.codering === "base64" ? Buffer.from(inhoud.data, "base64") : Buffer.from(inhoud.data, "utf8");
  if (data.length > maxBytes) throw new PlatformFout(413, "inhoud-te-groot", `De inhoud is groter dan ${maxBytes} bytes.`);
  return data;
}

const ONLEESBAAR = () =>
  new PlatformFout(410, "onleesbaar", "De sleutel van dit stuk is vernietigd. De inhoud is onleesbaar; de registratie blijft bestaan.");

async function datasleutel(m: Middelen, gemeente: string, id: string, verpakt: string | null): Promise<Buffer> {
  if (!m.sleutelbeheer || !verpakt) {
    throw new PlatformFout(503, "sleutelbeheer-uit", "Dit stuk is versleuteld, maar het sleutelbeheer is in deze omgeving niet ingesteld.");
  }
  try {
    return await m.sleutelbeheer.pakUit(gemeente, id, verpakt);
  } catch (e) {
    if (e instanceof SleutelVernietigd) throw ONLEESBAAR();
    throw e;
  }
}

export async function voegVersieToe(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  inhoud: Inhoud,
  verwachteVolgnummer?: number,
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id, verwachteVolgnummer);
  if (staat.onleesbaar) throw ONLEESBAAR();
  const data = decodeer(inhoud, m.maxBytes);
  const sha256 = createHash("sha256").update(data).digest("hex");

  const laatste = await c.query(
    "SELECT nummer, sha256 FROM versies WHERE object = $1 ORDER BY nummer DESC LIMIT 1",
    [id],
  );
  if (laatste.rowCount && laatste.rows[0].sha256 === sha256) {
    // Ongewijzigde inhoud: geen nieuwe versie, geen gebeurtenis.
    return leesObject(c, id);
  }
  const nummer = laatste.rowCount ? laatste.rows[0].nummer + 1 : 1;
  const sleutel = `${id}/${nummer}-${sha256.slice(0, 16)}`;
  const opTeSlaan = staat.versleuteld
    ? versleutel(await datasleutel(m, gemeente, id, staat.verpakt), data, `${id}/${nummer}`)
    : data;

  // Eerst opslaan, dan vastleggen: mislukt de transactie, dan blijft hooguit
  // een wees achter in de opslag, nooit een registratie zonder inhoud.
  await m.opslag.schrijf(gemeente, sleutel, opTeSlaan, staat.versleuteld ? "application/octet-stream" : inhoud.mediaType);

  const g = await legGebeurtenisVast(c, gemeente, "versie.vastgelegd", id, actor, {
    nummer,
    sha256,
    grootte: data.length,
    mediaType: inhoud.mediaType,
    formaat: inhoud.formaat,
  });
  await c.query(
    `INSERT INTO versies (object, gemeente, nummer, sha256, grootte, media_type, formaat, opslagsleutel, vastgelegd, door, versleuteld)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, gemeente, nummer, sha256, data.length, inhoud.mediaType, inhoud.formaat, sleutel, g.tijdstip, actor.sub, staat.versleuteld],
  );
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  return leesObject(c, id);
}

/** Leest de inhoud van een versie, ontsleutelt waar nodig en controleert de sha-256. */
export async function leesInhoud(
  c: Client,
  m: Middelen,
  gemeente: string,
  id: string,
  nummer: number,
): Promise<{ data: Buffer; mediaType: string; formaat: string }> {
  const r = await c.query(
    `SELECT v.*, o.sleutel_verpakt, o.onleesbaar_gemaakt FROM versies v JOIN objecten o ON o.identificatie = v.object
      WHERE v.object = $1 AND v.nummer = $2`,
    [id, nummer],
  );
  if (r.rowCount === 0) throw new PlatformFout(404, "versie-onbekend", "Deze versie bestaat niet.");
  const v = r.rows[0];
  if (v.onleesbaar_gemaakt) throw ONLEESBAAR();
  const opgeslagen = await m.opslag.lees(gemeente, v.opslagsleutel);
  let data = opgeslagen;
  if (v.versleuteld) {
    try {
      data = ontsleutel(await datasleutel(m, gemeente, id, v.sleutel_verpakt), opgeslagen, `${id}/${nummer}`);
    } catch (e) {
      if (e instanceof PlatformFout) throw e;
      throw new PlatformFout(500, "integriteit", "De versleutelde inhoud is niet te ontsleutelen.");
    }
  }
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== v.sha256) throw new PlatformFout(500, "integriteit", "De opgeslagen inhoud wijkt af van de registratie.");
  return { data, mediaType: v.media_type, formaat: v.formaat };
}

/**
 * Onleesbaar maken: de sleutel van het object vernietigen. Onherroepelijk.
 * Alleen voor versleutelde objecten; de registratie en de gebeurtenissen
 * blijven bestaan. Eerst vastleggen, dan vernietigen: lukt vernietigen niet,
 * dan wordt de vastlegging teruggedraaid.
 */
export async function maakOnleesbaar(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  reden: string,
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id);
  if (staat.onleesbaar) throw ONLEESBAAR();
  if (!staat.versleuteld) {
    throw new PlatformFout(409, "niet-versleuteld", "Dit stuk is niet versleuteld; onleesbaar maken door de sleutel te vernietigen kan niet.");
  }
  if (!m.sleutelbeheer) throw new PlatformFout(503, "sleutelbeheer-uit", "Het sleutelbeheer is in deze omgeving niet ingesteld.");
  const g = await legGebeurtenisVast(c, gemeente, "object.onleesbaar-gemaakt", id, actor, { reden });
  await c.query(
    "UPDATE objecten SET onleesbaar_gemaakt = $2, sleutel_verpakt = NULL, laatste_volgnummer = $3 WHERE identificatie = $1",
    [id, g.tijdstip, g.volgnummer],
  );
  await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  await m.sleutelbeheer.vernietig(gemeente, id);
  return leesObject(c, id);
}
