/**
 * NeonDB HTTP client wrapper.
 *
 * Uses @neondatabase/serverless which talks to Neon over HTTPS — no TCP
 * sockets, no connection pool, perfectly suited to Vercel's serverless model.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let cached: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not configured');
  }
  cached = neon(url);
  return cached;
}
