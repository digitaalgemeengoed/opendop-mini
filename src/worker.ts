import pg from "pg";

/**
 * Verwerkt de outbox: het zware werk na een vastlegging (OA-ADR-003).
 *
 * In fase 1 kent de worker alleen de taak "zoekindex", die nog niets doet
 * behalve afmelden. Waarmerken en lakken volgen in fase 3. Het formaat van
 * de taken is zo gekozen dat Debezium en Kafka later kunnen worden
 * ingeschoven zonder de gebeurtenissen te veranderen.
 *
 * De worker verbindt met de beheerverbinding, omdat hij voor alle
 * gemeenten werkt.
 */
export type Taakverwerker = (taak: { id: number; gemeente: string; volgnummer: number; taak: string }) => Promise<void>;

export const standaardVerwerkers: Record<string, Taakverwerker> = {
  zoekindex: async () => {
    // Fase 3: inhoud en metadata naar de zoekindex.
  },
};

export async function verwerkRonde(pool: pg.Pool, verwerkers = standaardVerwerkers, maxPerRonde = 20): Promise<number> {
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
          [t.id, (e as Error).message],
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

export async function draaiWorker(url: string, intervalMs = 1000): Promise<() => void> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  let actief = true;
  const lus = async () => {
    while (actief) {
      try {
        const n = await verwerkRonde(pool);
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
