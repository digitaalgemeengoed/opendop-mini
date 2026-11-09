import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  Aard,
  Gebeurtenis,
  Gebeurtenistype,
  Inhoud,
  Informatieobject,
  Objecttype,
  Versie,
  Weergave,
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

export async function legGebeurtenisVast(
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
  const w = await c.query(
    "SELECT nummer, formaat, media_type, grootte, sha256, soort, volgnummer FROM weergaven WHERE object = $1 ORDER BY nummer, soort DESC, formaat, volgnummer",
    [id],
  );
  const weergavenVan = (nummer: number): Weergave[] =>
    w.rows
      .filter((x) => x.nummer === nummer)
      .map((x) => ({
        formaat: x.formaat,
        mediaType: x.media_type,
        grootte: Number(x.grootte),
        sha256: x.sha256,
        ...(x.soort === "geanonimiseerd" ? { soort: "geanonimiseerd" as const, volgnummer: x.volgnummer } : {}),
      }));
  const type = await leesObjecttype(c, o.objecttype_naam, o.objecttype_versie);
  // Een persoonlijk stuk heeft geen metadata: dan is er ook niets onvolledig.
  const t = o.aard === "persoonlijk" ? { ontbreekt: [] as string[] } : toets(`${type.naam}@${type.versie}`, type.schema, o.metadata);
  return {
    identificatie: o.identificatie,
    aard: o.aard,
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
        ...(weergavenVan(x.nummer).length ? { weergaven: weergavenVan(x.nummer) } : {}),
        ...(x.soort && x.soort !== "gewoon" ? { soort: x.soort, ...(x.bronversie ? { bronversie: x.bronversie } : {}) } : {}),
        ...(x.ppl ? { ppl: x.ppl } : {}),
        ...(x.beperkt ? { beperkt: true } : {}),
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
  vraag: { objecttype: string; aard?: Aard; metadata?: Record<string, unknown>; inhoud?: Inhoud; weergave?: Inhoud },
): Promise<ObjectMetStaat> {
  const type = await leesObjecttype(c, vraag.objecttype);
  const aard: Aard = vraag.aard ?? "zakelijk";
  const metadata = vraag.metadata ?? {};
  if (aard === "persoonlijk") {
    if (Object.keys(metadata).length) throw GEEN_METADATA();
  } else weigerOngeldig(toets(`${type.naam}@${type.versie}`, type.schema, metadata));

  const id = randomUUID();
  // De sleutel bestaat vóór de registratie; mislukt de transactie, dan blijft
  // hooguit een ongebruikte sleutel achter.
  const verpakt = m.sleutelbeheer ? await m.sleutelbeheer.maakObjectsleutel(gemeente, id) : null;
  const g = await legGebeurtenisVast(c, gemeente, "object.aangemaakt", id, actor, {
    objecttype: { naam: type.naam, versie: type.versie },
    aard,
    metadata,
    versleuteld: verpakt !== null,
  });
  await c.query(
    `INSERT INTO objecten (identificatie, gemeente, objecttype_naam, objecttype_versie, metadata,
                           laatste_volgnummer, aangemaakt, aangemaakt_door, versleuteld, sleutel_verpakt, aard)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, gemeente, type.naam, type.versie, metadata, g.volgnummer, g.tijdstip, actor.sub, verpakt !== null, verpakt, aard],
  );
  // Persoonlijke stukken gaan niet in de zoekindex.
  if (aard === "zakelijk") await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  if (vraag.inhoud) await voegVersieToe(c, m, gemeente, actor, id, vraag.inhoud, undefined, vraag.weergave);
  return leesObject(c, id);
}

export async function vergrendel(
  c: Client,
  id: string,
  verwacht?: number,
): Promise<{ versleuteld: boolean; verpakt: string | null; onleesbaar: boolean; aard: Aard }> {
  const r = await c.query(
    "SELECT laatste_volgnummer, versleuteld, sleutel_verpakt, onleesbaar_gemaakt, aard FROM objecten WHERE identificatie = $1 FOR UPDATE",
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
  return { versleuteld: r.rows[0].versleuteld, verpakt: r.rows[0].sleutel_verpakt, onleesbaar: !!r.rows[0].onleesbaar_gemaakt, aard: r.rows[0].aard };
}

const GEEN_METADATA = () =>
  new PlatformFout(409, "persoonlijk-geen-metadata", "Een persoonlijk stuk heeft geen metadata. Maak het eerst zakelijk.");

/**
 * Een persoonlijk stuk is alleen zichtbaar voor wie het vastlegde. Voor
 * anderen bestaat het niet (404): ook het bestaan blijft persoonlijk.
 */
export async function toetsToegang(c: Client, id: string, actor: Actor): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PlatformFout(404, "object-onbekend", "Dit object bestaat niet.");
  const r = await c.query("SELECT aard, aangemaakt_door FROM objecten WHERE identificatie = $1", [id]);
  if (r.rowCount === 0 || (r.rows[0].aard === "persoonlijk" && r.rows[0].aangemaakt_door !== actor.sub)) {
    throw new PlatformFout(404, "object-onbekend", "Dit object bestaat niet.");
  }
}

export async function legMetadataVast(
  c: Client,
  gemeente: string,
  actor: Actor,
  id: string,
  metadata: Record<string, unknown>,
  verwachteVolgnummer?: number,
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id, verwachteVolgnummer);
  if (staat.aard === "persoonlijk") throw GEEN_METADATA();
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
  weergave?: Inhoud,
  opties: { soort?: "gewoon" | "anonimisering" | "terugzetting"; bronversie?: number; ppl?: number } = {},
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id, verwachteVolgnummer);
  if (staat.onleesbaar) throw ONLEESBAAR();
  const data = decodeer(inhoud, m.maxBytes);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (weergave && weergave.formaat === inhoud.formaat) {
    throw new PlatformFout(400, "verzoek-ongeldig", "Een weergave heeft een ander formaat dan de versie zelf.");
  }
  const wData = weergave ? decodeer(weergave, m.maxBytes) : null;
  const wSha = wData ? createHash("sha256").update(wData).digest("hex") : null;
  // Een docx of odt verschilt bij elke export; vergelijk dan de weergave.
  const vergelijk = wSha ?? sha256;

  const laatste = await c.query(
    "SELECT nummer, COALESCE(vergelijk_sha256, sha256) AS vergelijk FROM versies WHERE object = $1 ORDER BY nummer DESC LIMIT 1",
    [id],
  );
  if (laatste.rowCount && laatste.rows[0].vergelijk === vergelijk) {
    // Ongewijzigde inhoud: geen nieuwe versie, geen gebeurtenis.
    return leesObject(c, id);
  }
  const nummer = laatste.rowCount ? laatste.rows[0].nummer + 1 : 1;
  const sleutel = `${id}/${nummer}-${sha256.slice(0, 16)}`;
  const dek = staat.versleuteld ? await datasleutel(m, gemeente, id, staat.verpakt) : null;
  const opTeSlaan = dek ? versleutel(dek, data, `${id}/${nummer}`) : data;

  // Eerst opslaan, dan vastleggen: mislukt de transactie, dan blijft hooguit
  // een wees achter in de opslag, nooit een registratie zonder inhoud.
  const ruimte = staat.aard;
  await m.opslag.schrijf(gemeente, sleutel, opTeSlaan, dek ? "application/octet-stream" : inhoud.mediaType, ruimte);
  const wSleutel = weergave ? `${id}/${nummer}-${wSha!.slice(0, 16)}.${weergave.formaat}` : null;
  if (weergave && wData && wSleutel) {
    const w = dek ? versleutel(dek, wData, `${id}/${nummer}/${weergave.formaat}`) : wData;
    await m.opslag.schrijf(gemeente, wSleutel, w, dek ? "application/octet-stream" : weergave.mediaType, ruimte);
  }

  const g = await legGebeurtenisVast(c, gemeente, "versie.vastgelegd", id, actor, {
    nummer,
    sha256,
    grootte: data.length,
    mediaType: inhoud.mediaType,
    formaat: inhoud.formaat,
    ...(opties.soort && opties.soort !== "gewoon" ? { soort: opties.soort, bronversie: opties.bronversie } : {}),
    ...(weergave ? { weergaven: [{ formaat: weergave.formaat, mediaType: weergave.mediaType, sha256: wSha, grootte: wData!.length }] } : {}),
  });
  await c.query(
    `INSERT INTO versies (object, gemeente, nummer, sha256, grootte, media_type, formaat, opslagsleutel, vastgelegd, door, versleuteld, vergelijk_sha256, ruimte,
                          soort, bronversie, ppl)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             COALESCE($16, (SELECT ppl_werk FROM objecten WHERE identificatie = $1)))`,
    [
      id,
      gemeente,
      nummer,
      sha256,
      data.length,
      inhoud.mediaType,
      inhoud.formaat,
      sleutel,
      g.tijdstip,
      actor.sub,
      staat.versleuteld,
      wSha,
      ruimte,
      opties.soort ?? "gewoon",
      opties.bronversie ?? null,
      opties.ppl ?? null,
    ],
  );
  if (weergave && wData) {
    await c.query(
      `INSERT INTO weergaven (object, gemeente, nummer, formaat, media_type, sha256, grootte, opslagsleutel, versleuteld, ruimte)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, gemeente, nummer, weergave.formaat, weergave.mediaType, wSha, wData.length, wSleutel, staat.versleuteld, ruimte],
    );
  }
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  if (staat.aard === "zakelijk") await zetInOutbox(c, gemeente, g.volgnummer, "zoekindex");
  return leesObject(c, id);
}

/**
 * Een persoonlijk stuk zakelijk maken: dat kan altijd. Alle versies en
 * weergaven komen als kopie in de bucket van de gemeente (het archief); de
 * registratie wijst daarna daarheen. Metadata volgt via Metadateren; tot dan
 * heet het stuk onvolledig. In het prototype blijft de persoonlijke kopie
 * staan; opruimen volgt.
 *
 * Andersom (zakelijk naar persoonlijk) kan hier nog niet: straks binnen de
 * bedenktijd, of op verzoek bij de informatiebeheerder.
 */
export async function wijzigAard(c: Client, m: Middelen, gemeente: string, actor: Actor, id: string, aard: Aard): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id);
  if (staat.aard === aard) return leesObject(c, id);
  if (aard === "persoonlijk") {
    throw new PlatformFout(
      409,
      "persoonlijk-niet-toegestaan",
      "Een zakelijk stuk persoonlijk maken kan in het prototype nog niet. Straks kan dat binnen de bedenktijd, of op verzoek bij de informatiebeheerder.",
    );
  }
  for (const tabel of ["versies", "weergaven"] as const) {
    const r = await c.query(`SELECT opslagsleutel, media_type, versleuteld FROM ${tabel} WHERE object = $1 AND ruimte = 'persoonlijk'`, [id]);
    for (const rij of r.rows) {
      const data = await m.opslag.lees(gemeente, rij.opslagsleutel, "persoonlijk");
      try {
        await m.opslag.schrijf(gemeente, rij.opslagsleutel, data, rij.versleuteld ? "application/octet-stream" : rij.media_type, "zakelijk");
      } catch (e) {
        // Al gekopieerd bij een eerdere poging die daarna mislukte: zelfde sleutel, zelfde inhoud.
        if (!/bestaat al|PreconditionFailed|412/i.test(String((e as Error).message ?? e))) throw e;
      }
    }
    await c.query(`UPDATE ${tabel} SET ruimte = 'zakelijk' WHERE object = $1`, [id]);
  }
  const g = await legGebeurtenisVast(c, gemeente, "aard.gewijzigd", id, actor, { van: staat.aard, naar: aard });
  await c.query("UPDATE objecten SET aard = $2, laatste_volgnummer = $3 WHERE identificatie = $1", [id, aard, g.volgnummer]);
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
  const opgeslagen = await m.opslag.lees(gemeente, v.opslagsleutel, v.ruimte);
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

/** Leest een weergave van een versie (bijvoorbeeld de html), ontsleutelt en controleert. */
export async function leesWeergave(
  c: Client,
  m: Middelen,
  gemeente: string,
  id: string,
  nummer: number,
  formaat: string,
  soort: "weergave" | "geanonimiseerd" = "weergave",
): Promise<{ data: Buffer; mediaType: string; formaat: string }> {
  // Van een geanonimiseerde weergave geldt de laatste (hoogste volgnummer).
  const r = await c.query(
    `SELECT w.*, o.sleutel_verpakt, o.onleesbaar_gemaakt FROM weergaven w JOIN objecten o ON o.identificatie = w.object
      WHERE w.object = $1 AND w.nummer = $2 AND w.formaat = $3 AND w.soort = $4 ORDER BY w.volgnummer DESC LIMIT 1`,
    [id, nummer, formaat, soort],
  );
  if (r.rowCount === 0) throw new PlatformFout(404, "weergave-onbekend", "Deze versie heeft geen weergave in dit formaat.");
  const w = r.rows[0];
  if (w.onleesbaar_gemaakt) throw ONLEESBAAR();
  const opgeslagen = await m.opslag.lees(gemeente, w.opslagsleutel, w.ruimte);
  let data = opgeslagen;
  if (w.versleuteld) {
    try {
      data = ontsleutel(await datasleutel(m, gemeente, id, w.sleutel_verpakt), opgeslagen, contextVan(id, nummer, formaat, w.soort, w.volgnummer));
    } catch (e) {
      if (e instanceof PlatformFout) throw e;
      throw new PlatformFout(500, "integriteit", "De versleutelde weergave is niet te ontsleutelen.");
    }
  }
  if (createHash("sha256").update(data).digest("hex") !== w.sha256) {
    throw new PlatformFout(500, "integriteit", "De opgeslagen weergave wijkt af van de registratie.");
  }
  return { data, mediaType: w.media_type, formaat: w.formaat };
}

/** Waaraan de versleuteling van een weergave is gebonden (AAD). Een gewone weergave houdt de vorm van vóór migratie 005. */
const contextVan = (id: string, nummer: number, formaat: string, soort = "weergave", volgnummer = 1) =>
  soort === "weergave" ? `${id}/${nummer}/${formaat}` : `${id}/${nummer}/${formaat}/${soort}-${volgnummer}`;

/**
 * Een geanonimiseerde weergave vastleggen bij een versie. Wat is afgeschermd,
 * heeft de medewerker bevestigd; de gebeurtenis bevat alleen de aantallen per
 * soort, niet de gegevens zelf. Het origineel blijft ongewijzigd.
 */
export async function legAnonimiseringVast(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  nummer: number,
  html: Inhoud,
  overzicht: Record<string, number>,
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id);
  if (staat.onleesbaar) throw ONLEESBAAR();
  if (html.formaat !== "html") throw new PlatformFout(400, "verzoek-ongeldig", "Een geanonimiseerde weergave is html.");
  const v = await c.query("SELECT 1 FROM versies WHERE object = $1 AND nummer = $2", [id, nummer]);
  if (v.rowCount === 0) throw new PlatformFout(404, "versie-onbekend", "Deze versie bestaat niet.");
  const data = decodeer(html, m.maxBytes);
  const sha = createHash("sha256").update(data).digest("hex");
  const vorige = await c.query(
    "SELECT volgnummer, sha256 FROM weergaven WHERE object = $1 AND nummer = $2 AND formaat = 'html' AND soort = 'geanonimiseerd' ORDER BY volgnummer DESC LIMIT 1",
    [id, nummer],
  );
  // Ongewijzigd ten opzichte van de vorige anonimisering: niets vastleggen.
  if (vorige.rowCount && vorige.rows[0].sha256 === sha) return leesObject(c, id);
  const volgnummer = vorige.rowCount ? vorige.rows[0].volgnummer + 1 : 1;
  const dek = staat.versleuteld ? await datasleutel(m, gemeente, id, staat.verpakt) : null;
  const sleutel = `${id}/${nummer}-geanonimiseerd-${volgnummer}-${sha.slice(0, 16)}.html`;
  const opTeSlaan = dek ? versleutel(dek, data, contextVan(id, nummer, "html", "geanonimiseerd", volgnummer)) : data;
  await m.opslag.schrijf(gemeente, sleutel, opTeSlaan, dek ? "application/octet-stream" : html.mediaType, staat.aard);
  const schoon = Object.fromEntries(Object.entries(overzicht).filter(([k, n]) => /^[a-z-]{2,30}$/.test(k) && Number.isInteger(n) && n >= 0));
  const g = await legGebeurtenisVast(c, gemeente, "anonimisering.vastgelegd", id, actor, { versie: nummer, volgnummer, sha256: sha, afgeschermd: schoon });
  await c.query(
    `INSERT INTO weergaven (object, gemeente, nummer, formaat, media_type, sha256, grootte, opslagsleutel, versleuteld, ruimte, soort, volgnummer)
     VALUES ($1, $2, $3, 'html', $4, $5, $6, $7, $8, $9, 'geanonimiseerd', $10)`,
    [id, gemeente, nummer, html.mediaType, sha, data.length, sleutel, staat.versleuteld, staat.aard, volgnummer],
  );
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  return leesObject(c, id);
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
