import type pg from "pg";
import { regexUitVorm, type AnonimiseringsMeting, type MetingItem } from "@digitaalgemeengoed/oa-contract";

type Client = pg.PoolClient | pg.Pool;

/**
 * De kwaliteit van het anonimiseren, uit de metingen bij bevestigen.
 *
 * Wat telt als juist en als onterecht:
 *  - juist: een voorstel dat is bevestigd, of gelaten omdat het openbaar mag
 *    of van een andere soort is (de herkenning klopte wel);
 *  - onterecht: gelaten als "geen persoonsgegeven", of zonder reden (voorzichtig: telt mee);
 *  - gemist: wat de medewerker zelf toevoegde.
 * Wat standaard niet wordt geanonimiseerd (bijvoorbeeld data) en toch werd
 * bevestigd, is een keuze en geen vondst; dat telt apart.
 *
 * Precisie is betrouwbaar. De "gevonden"-ratio is een bovengrens voor de
 * recall: wat de assistent én de medewerker missen, ziet niemand.
 */

export const SCOREBANDEN = ["<0,5", "0,5–0,6", "0,6–0,7", "0,7–0,8", "0,8–0,9", "≥0,9"] as const;

function band(score: number): number {
  if (score < 0.5) return 0;
  return Math.min(5, Math.floor((score - 0.5) * 10) + 1);
}

type Klasse = "juist" | "onterecht" | "gemist" | "keuze" | null;

function klasse(i: MetingItem): Klasse {
  if (i.uitkomst === "toegevoegd") return "gemist";
  if (i.uitkomst === "bevestigd") return i.standaard ? "juist" : "keuze";
  if (i.reden === "mag-openbaar" || i.reden === "verkeerde-soort") return "juist";
  return "onterecht";
}

interface SoortTelling {
  soort: string;
  voorgesteld: number;
  bevestigd: number;
  keuze: number;
  gelaten: { "geen-persoonsgegeven": number; "mag-openbaar": number; "verkeerde-soort": number; zonder: number };
  toegevoegd: number;
  grondslagGewijzigd: number;
  juist: number;
  onterecht: number;
  /** juist / (juist + onterecht) */
  precisie: number | null;
  /** juist / (juist + gemist): een bovengrens voor de recall. */
  gevonden: number | null;
  scores: { juist: number[]; onterecht: number[] };
}

export interface Vorm {
  soort: string;
  klasse: "gemist" | "onterecht";
  vorm: string;
  regex: string;
  aantal: number;
  /** In hoeveel metingen (bevestigingen) de vorm voorkwam. */
  metingen: number;
  signaalwoorden: { woord: string; aantal: number }[];
  lengtes: Record<string, number>;
}

export interface Kwaliteit {
  dagen: number;
  drempel: number;
  metingen: number;
  gegevens: number;
  totaal: Omit<SoortTelling, "soort">;
  perSoort: SoortTelling[];
  perMotor: { motor: string; metingen: number; precisie: number | null; gevonden: number | null }[];
  vormen: Vorm[];
  /** Vormen die onder de drempel bleven (te zeldzaam om te tonen). */
  verborgen: number;
  grondslag: { van: string; naar: string; aantal: number }[];
  scorebanden: readonly string[];
}

function leeg(soort: string): SoortTelling {
  return {
    soort,
    voorgesteld: 0,
    bevestigd: 0,
    keuze: 0,
    gelaten: { "geen-persoonsgegeven": 0, "mag-openbaar": 0, "verkeerde-soort": 0, zonder: 0 },
    toegevoegd: 0,
    grondslagGewijzigd: 0,
    juist: 0,
    onterecht: 0,
    precisie: null,
    gevonden: null,
    scores: { juist: [0, 0, 0, 0, 0, 0], onterecht: [0, 0, 0, 0, 0, 0] },
  };
}

function tel(t: SoortTelling, i: MetingItem): void {
  const k = klasse(i);
  if (i.bron !== "medewerker") t.voorgesteld += 1;
  if (i.uitkomst === "bevestigd") {
    if (k === "keuze") t.keuze += 1;
    else t.bevestigd += 1;
  }
  if (i.uitkomst === "gelaten") t.gelaten[i.reden ?? "zonder"] += 1;
  if (i.uitkomst === "toegevoegd") t.toegevoegd += 1;
  if (i.categorie) t.grondslagGewijzigd += 1;
  if (k === "juist") t.juist += 1;
  if (k === "onterecht") t.onterecht += 1;
  if (i.score !== undefined && (k === "juist" || k === "onterecht")) t.scores[k][band(i.score)]! += 1;
}

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : Math.round((a / b) * 1000) / 1000;
}

function afronden(t: SoortTelling): void {
  t.precisie = ratio(t.juist, t.juist + t.onterecht);
  t.gevonden = ratio(t.juist, t.juist + t.toegevoegd);
}

export async function bewaarMeting(c: Client, gemeente: string, meting: AnonimiseringsMeting): Promise<void> {
  if (!meting.items.length) return;
  await c.query("INSERT INTO anonimisering_metingen (gemeente, motor, items) VALUES ($1, $2, $3)", [gemeente, meting.motor ?? null, JSON.stringify(meting.items)]);
}

export async function meetKwaliteit(c: Client, opties: { dagen: number; drempel: number }): Promise<Kwaliteit> {
  const r = await c.query("SELECT id, motor, items FROM anonimisering_metingen WHERE dag >= current_date - $1::int ORDER BY id", [opties.dagen]);
  const totaal = leeg("");
  const perSoort = new Map<string, SoortTelling>();
  const perMotor = new Map<string, { metingen: number; t: SoortTelling }>();
  const vormen = new Map<string, Vorm & { ids: Set<number>; woorden: Map<string, number> }>();
  const grondslag = new Map<string, number>();
  let gegevens = 0;
  for (const rij of r.rows) {
    const motor = (rij.motor as string | null) ?? "onbekend";
    const m = perMotor.get(motor) ?? { metingen: 0, t: leeg("") };
    m.metingen += 1;
    perMotor.set(motor, m);
    for (const i of rij.items as MetingItem[]) {
      gegevens += 1;
      const s = perSoort.get(i.soort) ?? leeg(i.soort);
      perSoort.set(i.soort, s);
      tel(s, i);
      tel(totaal, i);
      tel(m.t, i);
      if (i.categorie) {
        const k = `${i.categorie.van}→${i.categorie.naar}`;
        grondslag.set(k, (grondslag.get(k) ?? 0) + 1);
      }
      const k = klasse(i);
      if ((k === "gemist" || k === "onterecht") && i.vorm) {
        const sleutel = `${i.soort}\u0000${k}\u0000${i.vorm}`;
        const v = vormen.get(sleutel) ?? { soort: i.soort, klasse: k, vorm: i.vorm, regex: regexUitVorm(i.vorm), aantal: 0, metingen: 0, signaalwoorden: [], lengtes: {}, ids: new Set<number>(), woorden: new Map<string, number>() };
        v.aantal += 1;
        v.ids.add(Number(rij.id));
        if (i.signaal) v.woorden.set(i.signaal, (v.woorden.get(i.signaal) ?? 0) + 1);
        if (i.lengte) v.lengtes[i.lengte] = (v.lengtes[i.lengte] ?? 0) + 1;
        vormen.set(sleutel, v);
      }
    }
  }
  afronden(totaal);
  for (const s of perSoort.values()) afronden(s);
  const alleVormen = [...vormen.values()].map(({ ids, woorden, ...v }) => ({
    ...v,
    metingen: ids.size,
    signaalwoorden: [...woorden.entries()].map(([woord, aantal]) => ({ woord, aantal })).sort((a, b) => b.aantal - a.aantal).slice(0, 5),
  }));
  const zichtbaar = alleVormen.filter((v) => v.metingen >= opties.drempel).sort((a, b) => b.aantal - a.aantal).slice(0, 50);
  const { soort: _s, ...tot } = totaal;
  return {
    dagen: opties.dagen,
    drempel: opties.drempel,
    metingen: r.rowCount ?? 0,
    gegevens,
    totaal: tot,
    perSoort: [...perSoort.values()].sort((a, b) => b.voorgesteld + b.toegevoegd - (a.voorgesteld + a.toegevoegd)),
    perMotor: [...perMotor.entries()].map(([motor, m]) => {
      afronden(m.t);
      return { motor, metingen: m.metingen, precisie: m.t.precisie, gevonden: m.t.gevonden };
    }),
    vormen: zichtbaar,
    verborgen: alleVormen.length - zichtbaar.length,
    grondslag: [...grondslag.entries()].map(([k, aantal]) => ({ van: k.split("→")[0]!, naar: k.split("→")[1]!, aantal })).sort((a, b) => b.aantal - a.aantal),
    scorebanden: SCOREBANDEN,
  };
}
