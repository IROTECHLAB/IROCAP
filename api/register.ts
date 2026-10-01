import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { getSql } from '../lib/db.js';
import { adminFromAuthHeader } from '../lib/admin.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const session = adminFromAuthHeader(req.headers.authorization);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as
      | { domain?: string }
      | undefined;
    const domain = body?.domain;

    if (!domain || typeof domain !== 'string' || domain.length > 255) {
      res.status(400).json({ error: 'invalid-domain' });
      return;
    }

    const sitekey = randomBytes(16).toString('hex');
    const secret = randomBytes(16).toString('hex');

    const sql = getSql();
    await sql`
      INSERT INTO sites (sitekey, secret, domain, active)
      VALUES (${sitekey}, ${secret}, ${domain}, TRUE)
    `;

    res.status(200).json({ sitekey, secret });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
