import "server-only";
import { Pool } from "pg";

/**
 * Play-count storage for the anon/free-tier gate.
 *
 * Design goals:
 *  - No DATABASE_URL → every call returns "unlimited" so local dev
 *    behavior is unchanged.
 *  - Self-bootstrapping — table is created on first use, no separate
 *    migration step (Vercel deploys don't run migrations for us).
 *  - Atomic across multiple keys — an anon user's cookie AND their IP
 *    both increment together, or neither does, so opening a private
 *    tab doesn't stack fresh plays on the same IP.
 *  - Refundable — if minting the Reactor token fails after claiming,
 *    we roll back the play count so the user isn't billed for nothing.
 */

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS plays (
    id TEXT PRIMARY KEY,
    plays_used INT NOT NULL DEFAULT 0,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_play_at TIMESTAMPTZ
  );
`;

let poolPromise: Promise<Pool | null> | null = null;

async function getPool(): Promise<Pool | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null; // local dev — every function short-circuits below
  if (!poolPromise) {
    poolPromise = (async () => {
      // Managed Postgres providers (Neon/Supabase/Railway) require SSL;
      // rejectUnauthorized=false is standard for pooled connection URLs
      // where certs aren't distributed to the client.
      const pool = new Pool({
        connectionString: url,
        ssl:
          url.includes("sslmode=require") || url.includes(".neon.")
            ? { rejectUnauthorized: false }
            : undefined,
        max: 4,
      });
      await pool.query(CREATE_TABLE_SQL);
      return pool;
    })();
  }
  return poolPromise;
}

/**
 * Try to claim one play across ALL supplied identity keys. Semantics:
 *
 *   - Any single key already at `limit` → returns { ok: false, remaining: 0 }
 *     and NOTHING is incremented (all-or-none).
 *   - All keys under the limit → each is incremented by 1 and
 *     { ok: true, remaining: <cap for this identity> } is returned.
 *   - No DATABASE_URL → { ok: true, remaining: Infinity }.
 *
 * `keys` is typically a 2-tuple for anon users (`anon:<cookie>` +
 * `ip:<hash>`) or a 1-tuple for signed-in users (`user:<email>`), with
 * the SAME limit passed for each key of one identity.
 */
export async function claimPlay(
  keys: string[],
  limit: number,
): Promise<{ ok: boolean; remaining: number }> {
  const pool = await getPool();
  if (!pool) return { ok: true, remaining: Number.POSITIVE_INFINITY };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock every row we care about first (in a fixed order to avoid
    // deadlocks between concurrent claims), then check + increment.
    const sorted = [...keys].sort();
    let maxUsed = 0;
    for (const key of sorted) {
      const r = await client.query<{ plays_used: number }>(
        `INSERT INTO plays (id) VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING plays_used`,
        [key],
      );
      // Re-select FOR UPDATE to actually take the row lock (INSERT ...
      // ON CONFLICT UPDATE briefly holds it, but a bare SELECT afterwards
      // is racy — this is the belt-and-braces path).
      const locked = await client.query<{ plays_used: number }>(
        `SELECT plays_used FROM plays WHERE id = $1 FOR UPDATE`,
        [key],
      );
      const used = locked.rows[0]?.plays_used ?? r.rows[0]?.plays_used ?? 0;
      if (used >= limit) {
        await client.query("ROLLBACK");
        return { ok: false, remaining: 0 };
      }
      if (used > maxUsed) maxUsed = used;
    }
    for (const key of sorted) {
      await client.query(
        `UPDATE plays SET plays_used = plays_used + 1, last_play_at = NOW()
         WHERE id = $1`,
        [key],
      );
    }
    await client.query("COMMIT");
    return { ok: true, remaining: Math.max(0, limit - (maxUsed + 1)) };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore — the txn already failed
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Roll back a previously-claimed play across every supplied key. Used
 *  when Reactor token minting fails after a successful claim, so the
 *  user isn't charged for a session that never started. */
export async function refundPlay(keys: string[]): Promise<void> {
  const pool = await getPool();
  if (!pool) return;
  for (const key of keys) {
    await pool.query(
      `UPDATE plays SET plays_used = GREATEST(plays_used - 1, 0) WHERE id = $1`,
      [key],
    );
  }
}

/** Read-only "how many plays does this identity have left" for the HUD
 *  chip. Returns Infinity when the DB isn't configured. */
export async function playsRemaining(
  keys: string[],
  limit: number,
): Promise<number> {
  const pool = await getPool();
  if (!pool) return Number.POSITIVE_INFINITY;
  let maxUsed = 0;
  for (const key of keys) {
    const r = await pool.query<{ plays_used: number }>(
      `SELECT plays_used FROM plays WHERE id = $1`,
      [key],
    );
    const used = r.rows[0]?.plays_used ?? 0;
    if (used > maxUsed) maxUsed = used;
  }
  return Math.max(0, limit - maxUsed);
}
