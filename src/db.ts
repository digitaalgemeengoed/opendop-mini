import pg from "pg";

export type Client = pg.PoolClient;

let pool: pg.Pool | null = null;

export function maakPool(url: string): pg.Pool {
  pool = new pg.Pool({ connectionString: url, max: 10 });
  return pool;
}

export function huidigePool(): pg.Pool {
  if (!pool) throw new Error("Databaseverbinding is niet geopend");
  return pool;
}

/**
 * Voert werk uit in één transactie, met de gemeente als sessie-instelling.
 * Row Level Security leest die instelling; buiten deze functie ziet de
 * applicatie geen enkele rij.
 */
export async function inGemeente<T>(gemeente: string, werk: (c: Client) => Promise<T>): Promise<T> {
  const c = await huidigePool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('oa.gemeente', $1, true)", [gemeente]);
    const uitkomst = await werk(c);
    await c.query("COMMIT");
    return uitkomst;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
