import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../lib/db.js';
import { adminFromAuthHeader } from '../lib/admin.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const session = adminFromAuthHeader(req.headers.authorization);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const sql = getSql();

    const [sites, ch24, tk24, tkUsed] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM sites WHERE active = TRUE`,
      sql`SELECT COUNT(*)::int AS n FROM challenges WHERE created_at > NOW() - INTERVAL '24 hours'`,
      sql`SELECT COUNT(*)::int AS n FROM irocap_tokens WHERE created_at > NOW() - INTERVAL '24 hours'`,
      sql`SELECT COUNT(*)::int AS n FROM irocap_tokens WHERE created_at > NOW() - INTERVAL '24 hours' AND used = TRUE`,
    ]);

    const n = (r: unknown): number => (r as Array<{ n: number }>)[0]?.n ?? 0;

    res.status(200).json({
      active_sites: n(sites),
      challenges_24h: n(ch24),
      tokens_24h: n(tk24),
      tokens_used_24h: n(tkUsed),
    });
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
