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

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT sitekey, domain, active, created_at
      FROM sites
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const sites = rows as unknown as Array<{
      sitekey: string;
      domain: string;
      active: boolean;
      created_at: string;
    }>;
    res.status(200).json({ sites });
  } catch (err) {
    console.error('sites error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
