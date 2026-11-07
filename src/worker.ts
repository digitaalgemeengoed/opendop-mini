import pg from "pg";
import { leesInhoud, type Middelen } from "./objecten.js";
import { tekstUit, type Zoekindex } from "./zoekindex.js";

/**
 * Verwerkt de outbox: het zware werk na een vastlegging (OA-ADR-003).
 *
 * De worker verbindt met de beheerverbinding, omdat hij voor alle
 * gemeenten werkt. Het formaat van de taken is zo gekozen dat Debezium en
 * Kafka later kunnen worden ingeschoven zonder de gebeurtenissen te
 * veranderen.
 */
export interface Taak {
  id: number;
  gemeente: string;
  volgnummer: number;
  taak: string;
}
export type Taakverwerker = (taak: Taak) => Promise<void>;

/**
 * Taak "zoekindex": zet de huidige stand van het object in de index van de
 * gemeente, of haalt het eruit als het onleesbaar is gemaakt. Indexeert
 * altijd de huidige stand, dus de volgorde van taken maakt niet uit.
 * Versleutelde inhoud wordt hiervoor ontsleuteld; de index bevat dus
 * leesbare tekst en hoort even goed beschermd te worden als de opslag.
 */
export function maakVerwerkers(pool: pg.Pool, m: Middelen, zoekindex: Zoekindex): Record<string, Taakverwerker> {
  return {
    zoekindex: async ({ gemeente, volgnummer }) => {
      if (zoekindex.soort === "uit") return;
      const g = await pool.query("SELECT object_id FROM gebeurtenissen WHERE volgnummer = $1", [volgnummer]);
      const id: string | null = g.rows[0]?.object_id ?? null;
      if (!id) return;
      const o = await pool.query("SELECT * FROM objecten WHERE identificatie = $1", [id]);
      const obj = o.rows[0];
      if (!obj || obj.onleesbaar_gemaakt) {
        await zoekindex.verwijder(gemeente, id);
        return;
      }
      const v = await pool.query("SELECT nummer FROM versies WHERE object = $1 ORDER BY nummer DESC LIMIT 1", [id]);
      const versie: number | null = v.rows[0]?.nummer ?? null;
      let tekst = "";
      if (versie !== null) {
        const inhoud = await leesInhoud(pool as unknown as pg.PoolClient, m, gemeente, id, versie);
        tekst = tekstUit(inhoud.formaat, inhoud.data);
      }
      await zoekindex.indexeer(gemeente, {
        identificatie: id,
        objecttype: obj.objecttype_naam,
        versie,
        metadata: obj.metadata,
        tekst,
        bijgewerkt: new Date().toISOString(),
      });
    },
  };
}

export async function verwerkRonde(pool: pg.Pool, verwerkers: Record<string, Taakverwerker>, maxPerRonde = 20): Promise<number> {
  const c = await pool.connect();
  let aantal = 0;
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `SELECT id, gemeente, volgnummer, taak FROM outbox
        WHERE status = 'wachtend' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [maxPerRonde],
    );
    for (const t of r.rows) {
      const verwerker = verwerkers[t.taak];
      try {
        if (!verwerker) throw new Error(`geen verwerker voor taak ${t.taak}`);
        await verwerker({ id: Number(t.id), gemeente: t.gemeente, volgnummer: Number(t.volgnummer), taak: t.taak });
        await c.query("UPDATE outbox SET status = 'klaar', verwerkt = now(), pogingen = pogingen + 1 WHERE id = $1", [t.id]);
      } catch (e) {
        await c.query(
          `UPDATE outbox SET pogingen = pogingen + 1, laatste_fout = $2,
                  status = CASE WHEN pogingen + 1 >= 5 THEN 'mislukt' ELSE 'wachtend' END
            WHERE id = $1`,
          [t.id, (e as Error).message.slice(0, 500)],
        );
      }
      aantal++;
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return aantal;
}

export async function draaiWorker(url: string, m: Middelen, zoekindex: Zoekindex, intervalMs = 1000): Promise<() => void> {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const verwerkers = maakVerwerkers(pool, m, zoekindex);
  let actief = true;
  const lus = async () => {
    while (actief) {
      try {
        const n = await verwerkRonde(pool, verwerkers);
        if (n === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        console.error("worker:", (e as Error).message);
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
    await pool.end();
  };
  void lus();
  return () => {
    actief = false;
  };
}
