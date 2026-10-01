/**
 * Opportunistic cleanup.
 *
 * Vercel Hobby only allows a daily cron, so we also purge lazily from hot
 * endpoints. Sampling at ~2% keeps the tables tiny without adding measurable
 * latency to the other 98% of requests.
 *
 * Safe to call fire-and-forget: it never throws and never blocks the caller.
 */
import { getSql } from './db.js';

const SAMPLE_RATE = 0.02;

export interface CleanupCounts {
  challenges: number;
  tokens: number;
  rate_limits: number;
}

/** Delete rows older than their retention window. Returns counts. */
export async function runCleanup(): Promise<CleanupCounts> {
  const sql = getSql();

  const [chRows, tkRows, rlRows] = await Promise.all([
    sql`
      DELETE FROM challenges
      WHERE created_at < NOW() - INTERVAL '10 minutes'
      RETURNING id
    `,
    sql`
      DELETE FROM irocap_tokens
      WHERE created_at < NOW() - INTERVAL '1 hour'
      RETURNING token
    `,
    sql`
      DELETE FROM rate_limits
      WHERE window_start < NOW() - INTERVAL '5 minutes'
      RETURNING ip
    `,
  ]);

  const ch = chRows as unknown as Array<{ id: string }>;
  const tk = tkRows as unknown as Array<{ token: string }>;
  const rl = rlRows as unknown as Array<{ ip: string }>;

  return {
    challenges: ch.length,
    tokens: tk.length,
    rate_limits: rl.length,
  };
}

/**
 * Fire-and-forget opportunistic purge. Runs on a fraction of requests.
 * Never awaited, never throws.
 */
export function maybeCleanup(): void {
  if (Math.random() >= SAMPLE_RATE) return;
  void runCleanup().catch((err) => {
    console.warn(
      '[irocap] opportunistic cleanup failed:',
      err instanceof Error ? err.message : err,
    );
  });
}
