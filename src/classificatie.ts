import { createHash, randomUUID } from "node:crypto";
import {
  bepaalBewaren,
  controleerClassificatiemodel,
  isVergrendeld,
  resultatenInGebruik,
  rollenVan,
  rolWaarden,
  type Actor,
  type Classificatie,
  type Classificatiemodel,
  type ClassificatiemodelConfig,
  type Inhoud,
  type Objecttype,
  type Wijzigingsvoorstel,
} from "@digitaalgemeengoed/oa-contract";
import { SELECTIELIJST_2020 } from "@digitaalgemeengoed/oa-contract/selectielijst";
import type { Client } from "./db.js";
import {
  PlatformFout,
  datasleutel,
  decodeer,
  leesObject,
  leesObjecttype,
  legGebeurtenisVast,
  vergrendel,
  voegVersieToe,
  type Middelen,
  type ObjectMetStaat,
} from "./objecten.js";
import { ontsleutel, versleutel } from "./sleutelbeheer.js";

/**
 * Classificeren, bewaren, vergrendelen en wijzigingsvoorstellen.
 *
 * Het classificatiemodel heeft versies per gemeente. Een stuk onthoudt met
 * welke versie het is geclassificeerd (voor de bewaartermijn); of een stuk
 * vergrendeld is, volgt uit het model dat nu geldt en de status van het stuk.
 */

export const SELECTIELIJSTEN = { "gemeenten-2020": SELECTIELIJST_2020 } as const;
export const lijstVan = (c: Pick<ClassificatiemodelConfig, "selectielijst">) => SELECTIELIJSTEN[c.selectielijst] ?? SELECTIELIJST_2020;

function naarModel(r: Record<string, any>): Classificatiemodel {
  return { versie: r.versie, config: r.config, gepubliceerd: r.gepubliceerd.toISOString(), door: r.door ?? null };
}

export async function leesClassificatiemodel(c: Client, versie?: number): Promise<Classificatiemodel | null> {
  const r = versie
    ? await c.query("SELECT * FROM classificatiemodellen WHERE versie = $1", [versie])
    : await c.query("SELECT * FROM classificatiemodellen ORDER BY versie DESC LIMIT 1");
  return r.rowCount ? naarModel(r.rows[0]) : null;
}

export async function versiesClassificatiemodel(c: Client): Promise<Classificatiemodel[]> {
  return (await c.query("SELECT * FROM classificatiemodellen ORDER BY versie DESC")).rows.map(naarModel);
}

/** De waarden van het statusveld (rol status) in het objecttype, of null als het model geen status heeft. */
export function statussenVan(type: Pick<Objecttype, "schema">): string[] | null {
  const sleutel = rollenVan(type.schema).status;
  if (!sleutel) return null;
  const e = (type.schema as { properties?: Record<string, { enum?: string[] }> }).properties?.[sleutel];
  return e?.enum ? [...e.enum] : null;
}

export async function publiceerClassificatiemodel(c: Client, gemeente: string, actor: Actor, config: ClassificatiemodelConfig): Promise<Classificatiemodel> {
  const type = await leesObjecttype(c, "document");
  const fouten = controleerClassificatiemodel(config, lijstVan(config), statussenVan(type)).filter((p) => p.ernst === "fout");
  if (fouten.length) throw new PlatformFout(422, "model-ongeldig", "Het classificatiemodel klopt nog niet.", fouten.map((p) => ({ veld: p.sleutel ?? "", melding: p.melding })));
  const r = await c.query("SELECT COALESCE(MAX(versie), 0) + 1 AS v FROM classificatiemodellen");
  const versie = Number(r.rows[0].v);
  const g = await legGebeurtenisVast(c, gemeente, "classificatiemodel.gepubliceerd", null, actor, { versie, naam: config.naam ?? null });
  await c.query("INSERT INTO classificatiemodellen (gemeente, versie, config, gepubliceerd, door) VALUES ($1, $2, $3, $4, $5)", [
    gemeente,
    versie,
    config,
    g.tijdstip,
    actor.naam ?? actor.sub,
  ]);
  return (await leesClassificatiemodel(c, versie))!;
}

// ---------------------------------------------------------------------------
// Per stuk: status, vergrendeling, bewaren
// ---------------------------------------------------------------------------

/** Wat leesObject aan een stuk toevoegt. */
export async function verrijk(c: Client, o: ObjectMetStaat, rij: { classificatie: Classificatie | null; statusdata: Record<string, string> | null }, type: Objecttype): Promise<ObjectMetStaat> {
  const status = rolWaarden(type.schema, o.metadata).status ?? null;
  const actief = await leesClassificatiemodel(c);
  const eigen = rij.classificatie ? (rij.classificatie.modelversie === actief?.versie ? actief : await leesClassificatiemodel(c, rij.classificatie.modelversie)) : null;
  const statusdata = rij.statusdata ?? {};
  const open = await c.query("SELECT count(*)::int AS n FROM wijzigingsvoorstellen WHERE object = $1 AND status = 'open'", [o.identificatie]);
  return {
    ...o,
    status,
    statusdata,
    classificatie: rij.classificatie,
    bewaren: rij.classificatie && eigen ? bepaalBewaren(eigen.config, lijstVan(eigen.config), rij.classificatie, statusdata) : null,
    vergrendeld: o.aard !== "persoonlijk" && isVergrendeld(status, actief?.config) ? { status: status! } : null,
    voorstellen: open.rows[0].n,
  };
}

/** Na nieuwe metadata: de dag waarop het stuk een status voor het eerst kreeg. */
export async function onthoudStatus(c: Client, id: string, type: Objecttype, metadata: Record<string, unknown>, tijdstip: string): Promise<void> {
  const status = rolWaarden(type.schema, metadata).status;
  if (!status) return;
  await c.query(
    "UPDATE objecten SET statusdata = statusdata || jsonb_build_object($2::text, $3::text) WHERE identificatie = $1 AND NOT statusdata ? $2",
    [id, status, new Date(tijdstip).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" })],
  );
}

const VERGRENDELD = (status: string) =>
  new PlatformFout(409, "vergrendeld", `Dit stuk is ${status} en daarom vergrendeld. Dien een wijzigingsvoorstel in; een vrijgever beoordeelt het.`, { status });

/**
 * Een vergrendeld stuk: geen nieuwe versie, geen andere metadata of
 * classificatie. Een vrijgever mag metadata en classificatie wel wijzigen
 * (zo geeft hij een stuk vrij: een andere status).
 */
export async function toetsVergrendeling(c: Client, id: string, actor: Actor, wat: "versie" | "metadata"): Promise<void> {
  const o = await c.query("SELECT aard, metadata, objecttype_naam, objecttype_versie FROM objecten WHERE identificatie = $1", [id]);
  if (!o.rowCount || o.rows[0].aard === "persoonlijk") return;
  const model = await leesClassificatiemodel(c);
  if (!model) return;
  const type = await leesObjecttype(c, o.rows[0].objecttype_naam, o.rows[0].objecttype_versie);
  const status = rolWaarden(type.schema, o.rows[0].metadata).status;
  if (!isVergrendeld(status, model.config)) return;
  if (wat === "metadata" && actor.vrijgever) return;
  throw VERGRENDELD(status!);
}

export async function legClassificatieVast(
  c: Client,
  gemeente: string,
  actor: Actor,
  id: string,
  vraag: { resultaat: string; attributen?: Record<string, string | boolean>; einddatumProcesobject?: string; verwachteVolgnummer?: number },
): Promise<ObjectMetStaat> {
  const staat = await vergrendel(c, id, vraag.verwachteVolgnummer);
  if (staat.aard === "persoonlijk") throw new PlatformFout(409, "persoonlijk-geen-classificatie", "Een persoonlijk stuk wordt niet geclassificeerd. Maak het eerst zakelijk.");
  await toetsVergrendeling(c, id, actor, "metadata");
  const model = await leesClassificatiemodel(c);
  if (!model) throw new PlatformFout(409, "geen-classificatiemodel", "Deze gemeente heeft nog geen classificatiemodel. Stel het in het beheerportaal in.");
  const r = resultatenInGebruik(model.config, lijstVan(model.config)).find((x) => x.id === vraag.resultaat);
  const fouten: { veld: string; melding: string }[] = [];
  if (!r) fouten.push({ veld: "resultaat", melding: `Resultaat ${vraag.resultaat} is niet in gebruik in het classificatiemodel.` });
  const attributen: Record<string, string | boolean> = {};
  for (const a of model.config.attributen) {
    const w = vraag.attributen?.[a.sleutel];
    if (w === undefined || w === "") {
      if (a.verplicht) fouten.push({ veld: a.sleutel, melding: `${a.label} is verplicht.` });
      continue;
    }
    if (a.type === "ja-nee" && typeof w !== "boolean") fouten.push({ veld: a.sleutel, melding: `${a.label} is ja of nee.` });
    else if (a.type === "keuze" && !a.opties?.includes(String(w))) fouten.push({ veld: a.sleutel, melding: `${a.label}: kies een van de opties.` });
    else if (a.type === "tekst" && (typeof w !== "string" || w.length > 500)) fouten.push({ veld: a.sleutel, melding: `${a.label}: hoogstens 500 tekens.` });
    else attributen[a.sleutel] = w;
  }
  for (const k of Object.keys(vraag.attributen ?? {})) if (!model.config.attributen.some((a) => a.sleutel === k)) fouten.push({ veld: k, melding: `Onbekend attribuut: ${k}` });
  if (fouten.length) throw new PlatformFout(422, "classificatie-ongeldig", "De classificatie klopt niet met het classificatiemodel.", fouten);

  const classificatie: Classificatie = {
    modelversie: model.versie,
    resultaat: vraag.resultaat,
    ...(Object.keys(attributen).length ? { attributen } : {}),
    ...(vraag.einddatumProcesobject ? { einddatumProcesobject: vraag.einddatumProcesobject } : {}),
    door: actor.naam ?? actor.sub,
  };
  const g = await legGebeurtenisVast(c, gemeente, "classificatie.vastgelegd", id, actor, { ...classificatie });
  classificatie.op = g.tijdstip;
  await c.query("UPDATE objecten SET classificatie = $2, laatste_volgnummer = $3 WHERE identificatie = $1", [id, classificatie, g.volgnummer]);
  return leesObject(c, id);
}

// ---------------------------------------------------------------------------
// Wijzigingsvoorstellen
// ---------------------------------------------------------------------------

function naarVoorstel(r: Record<string, any>, titel?: string): Wijzigingsvoorstel {
  return {
    id: r.id,
    object: r.object,
    ...(titel ? { titel } : {}),
    bronversie: r.bronversie,
    reden: r.reden,
    door: r.door,
    ingediend: r.ingediend.toISOString(),
    status: r.status,
    formaat: r.formaat,
    ...(r.beoordeeld_op
      ? { beoordeling: { door: r.beoordeeld_door, op: r.beoordeeld_op.toISOString(), ...(r.toelichting ? { toelichting: r.toelichting } : {}), ...(r.versie ? { versie: r.versie } : {}) } }
      : {}),
  };
}

const wie = (a: Actor) => ({ sub: a.sub, ...(a.naam ? { naam: a.naam } : {}) });

export async function dienVoorstelIn(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  id: string,
  vraag: { inhoud: Inhoud; weergave?: Inhoud; reden: string },
): Promise<Wijzigingsvoorstel> {
  const staat = await vergrendel(c, id);
  try {
    await toetsVergrendeling(c, id, actor, "versie");
    throw new PlatformFout(409, "niet-vergrendeld", "Dit stuk is niet vergrendeld. Leg gewoon een nieuwe versie vast.");
  } catch (e) {
    if (!(e instanceof PlatformFout) || e.code !== "vergrendeld") throw e;
  }
  const data = decodeer(vraag.inhoud, m.maxBytes);
  const wData = vraag.weergave ? decodeer(vraag.weergave, m.maxBytes) : null;
  const vergelijk = createHash("sha256").update(wData ?? data).digest("hex");
  const laatste = await c.query("SELECT nummer, COALESCE(vergelijk_sha256, sha256) AS v FROM versies WHERE object = $1 ORDER BY nummer DESC LIMIT 1", [id]);
  if (laatste.rowCount && laatste.rows[0].v === vergelijk) {
    throw new PlatformFout(409, "ongewijzigd", "De inhoud is niet gewijzigd sinds de laatste versie. Er is niets voor te stellen.");
  }
  const vid = randomUUID();
  const dek = staat.versleuteld ? await datasleutel(m, gemeente, id, staat.verpakt) : null;
  const sleutel = `${id}/voorstel-${vid}`;
  await m.opslag.schrijf(gemeente, sleutel, dek ? versleutel(dek, data, `${id}/voorstel/${vid}`) : data, dek ? "application/octet-stream" : vraag.inhoud.mediaType, staat.aard);
  let wSleutel: string | null = null;
  if (vraag.weergave && wData) {
    wSleutel = `${sleutel}.${vraag.weergave.formaat}`;
    await m.opslag.schrijf(gemeente, wSleutel, dek ? versleutel(dek, wData, `${id}/voorstel/${vid}/${vraag.weergave.formaat}`) : wData, dek ? "application/octet-stream" : vraag.weergave.mediaType, staat.aard);
  }
  const g = await legGebeurtenisVast(c, gemeente, "voorstel.ingediend", id, actor, { voorstel: vid, reden: vraag.reden, bronversie: laatste.rows[0]?.nummer ?? 0 });
  await c.query(
    `INSERT INTO wijzigingsvoorstellen (id, gemeente, object, bronversie, reden, door, ingediend, formaat, media_type, opslagsleutel, w_formaat, w_media_type, w_opslagsleutel, versleuteld, ruimte)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [vid, gemeente, id, laatste.rows[0]?.nummer ?? 0, vraag.reden, wie(actor), g.tijdstip, vraag.inhoud.formaat, vraag.inhoud.mediaType, sleutel, vraag.weergave?.formaat ?? null, vraag.weergave?.mediaType ?? null, wSleutel, !!dek, staat.aard],
  );
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [id, g.volgnummer]);
  return naarVoorstel((await c.query("SELECT * FROM wijzigingsvoorstellen WHERE id = $1", [vid])).rows[0]);
}

export async function lijstVoorstellen(c: Client, filter: { object?: string; status?: string }): Promise<Wijzigingsvoorstel[]> {
  const r = await c.query(
    `SELECT w.*, o.metadata, o.objecttype_naam, o.objecttype_versie FROM wijzigingsvoorstellen w JOIN objecten o ON o.identificatie = w.object
      WHERE ($1::uuid IS NULL OR w.object = $1) AND ($2::text IS NULL OR w.status = $2)
      ORDER BY w.ingediend DESC LIMIT 200`,
    [filter.object ?? null, filter.status ?? null],
  );
  const types = new Map<string, Objecttype>();
  const uit: Wijzigingsvoorstel[] = [];
  for (const x of r.rows) {
    const k = `${x.objecttype_naam}@${x.objecttype_versie}`;
    if (!types.has(k)) types.set(k, await leesObjecttype(c, x.objecttype_naam, x.objecttype_versie));
    uit.push(naarVoorstel(x, rolWaarden(types.get(k)!.schema, x.metadata).titel));
  }
  return uit;
}

async function leesVoorstelInhoud(c: Client, m: Middelen, gemeente: string, v: Record<string, any>, deel: "inhoud" | "weergave"): Promise<Buffer> {
  const sleutel = deel === "inhoud" ? v.opslagsleutel : v.w_opslagsleutel;
  const blob = await m.opslag.lees(gemeente, sleutel, v.ruimte);
  if (!v.versleuteld) return blob;
  const o = await c.query("SELECT sleutel_verpakt FROM objecten WHERE identificatie = $1", [v.object]);
  const dek = await datasleutel(m, gemeente, v.object, o.rows[0].sleutel_verpakt);
  return ontsleutel(dek, blob, deel === "inhoud" ? `${v.object}/voorstel/${v.id}` : `${v.object}/voorstel/${v.id}/${v.w_formaat}`);
}

async function voorstelRij(c: Client, vid: string): Promise<Record<string, any>> {
  if (!/^[0-9a-f-]{36}$/i.test(vid)) throw new PlatformFout(404, "voorstel-onbekend", "Dit voorstel bestaat niet.");
  const r = await c.query("SELECT * FROM wijzigingsvoorstellen WHERE id = $1", [vid]);
  if (!r.rowCount) throw new PlatformFout(404, "voorstel-onbekend", "Dit voorstel bestaat niet.");
  return r.rows[0];
}

export async function leesVoorstel(c: Client, vid: string): Promise<Wijzigingsvoorstel> {
  return naarVoorstel(await voorstelRij(c, vid));
}

/** Het voorgestelde document als html, om te beoordelen. */
export async function leesVoorstelWeergave(c: Client, m: Middelen, gemeente: string, vid: string): Promise<Inhoud> {
  const v = await voorstelRij(c, vid);
  if (v.w_formaat === "html") return { formaat: "html", mediaType: "text/html", codering: "tekst", data: (await leesVoorstelInhoud(c, m, gemeente, v, "weergave")).toString("utf8") };
  if (v.formaat === "html") return { formaat: "html", mediaType: "text/html", codering: "tekst", data: (await leesVoorstelInhoud(c, m, gemeente, v, "inhoud")).toString("utf8") };
  throw new PlatformFout(404, "geen-weergave", "Van dit voorstel is geen html-weergave.");
}

export async function beoordeelVoorstel(
  c: Client,
  m: Middelen,
  gemeente: string,
  actor: Actor,
  vid: string,
  vraag: { besluit: "goedkeuren" | "afwijzen"; toelichting?: string },
): Promise<Wijzigingsvoorstel> {
  if (!actor.vrijgever) throw new PlatformFout(403, "geen-vrijgever", "Alleen een vrijgever mag een wijzigingsvoorstel beoordelen.");
  const v = await voorstelRij(c, vid);
  if (v.door?.sub === actor.sub) throw new PlatformFout(403, "eigen-voorstel", "Je beoordeelt je eigen voorstel niet. Vraag een andere vrijgever.");
  if (v.status !== "open") throw new PlatformFout(409, "al-beoordeeld", "Dit voorstel is al beoordeeld.");
  let versie: number | null = null;
  if (vraag.besluit === "goedkeuren") {
    const laatste = await c.query("SELECT max(nummer) AS n FROM versies WHERE object = $1", [v.object]);
    if (Number(laatste.rows[0].n ?? 0) !== v.bronversie) {
      throw new PlatformFout(409, "voorstel-verouderd", `Dit voorstel bouwt voort op versie ${v.bronversie}, maar het stuk is intussen versie ${laatste.rows[0].n}. Wijs het af en vraag een nieuw voorstel.`);
    }
    const inhoud: Inhoud = { formaat: v.formaat, mediaType: v.media_type, codering: "base64", data: (await leesVoorstelInhoud(c, m, gemeente, v, "inhoud")).toString("base64") };
    const weergave: Inhoud | undefined = v.w_opslagsleutel
      ? { formaat: v.w_formaat, mediaType: v.w_media_type, codering: "base64", data: (await leesVoorstelInhoud(c, m, gemeente, v, "weergave")).toString("base64") }
      : undefined;
    // De versie staat op naam van de indiener; de goedkeuring is een eigen gebeurtenis.
    const o = await voegVersieToe(c, m, gemeente, { sub: v.door.sub, ...(v.door.naam ? { naam: v.door.naam } : {}) }, v.object, inhoud, undefined, weergave, { vrijgave: true });
    versie = o.versies.at(-1)?.nummer ?? null;
  }
  const g = await legGebeurtenisVast(c, gemeente, vraag.besluit === "goedkeuren" ? "voorstel.goedgekeurd" : "voorstel.afgewezen", v.object, actor, {
    voorstel: vid,
    ...(versie ? { versie } : {}),
    ...(vraag.toelichting ? { toelichting: vraag.toelichting } : {}),
  });
  await c.query("UPDATE wijzigingsvoorstellen SET status = $2, beoordeeld_door = $3, beoordeeld_op = $4, toelichting = $5, versie = $6 WHERE id = $1", [
    vid,
    vraag.besluit === "goedkeuren" ? "goedgekeurd" : "afgewezen",
    wie(actor),
    g.tijdstip,
    vraag.toelichting ?? null,
    versie,
  ]);
  await c.query("UPDATE objecten SET laatste_volgnummer = $2 WHERE identificatie = $1", [v.object, g.volgnummer]);
  return naarVoorstel(await voorstelRij(c, vid));
}
