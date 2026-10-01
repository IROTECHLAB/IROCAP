/**
 * IP + sitekey rate limiting backed by NeonDB.
 *
 * Uses an atomic upsert so concurrent requests can't race past the limit.
 * Window is 60 seconds; default max is 60 challenges per window.
 */
import { getSql } from './db.js';

const WINDOW_SECONDS = 60;
const DEFAULT_MAX = 60;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

export async function checkRateLimit(
  ip: string,
  sitekey: string,
  max: number = DEFAULT_MAX,
): Promise<RateLimitResult> {
  const sql = getSql();

  const rows = await sql`
    INSERT INTO rate_limits (ip, sitekey, count, window_start)
    VALUES (${ip}::inet, ${sitekey}, 1, NOW())
    ON CONFLICT (ip, sitekey) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start < NOW() - (${WINDOW_SECONDS}::text || ' seconds')::interval
          THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start < NOW() - (${WINDOW_SECONDS}::text || ' seconds')::interval
          THEN NOW()
        ELSE rate_limits.window_start
      END
    RETURNING count
  `;

  const count = Number((rows[0] as { count: number } | undefined)?.count ?? 1);
  return { allowed: count <= max, count, limit: max };
}
