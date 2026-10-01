import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { getSql } from '../lib/db.js';
import { adminFromAuthHeader } from '../lib/admin.js';

type Action = 'rotate' | 'toggle' | 'delete';

interface Body {
  action?: Action;
  sitekey?: string;
}

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

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  let body: Body;
  try {
    body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Body;
  } catch {
    res.status(400).json({ error: 'invalid-json' });
    return;
  }

  const action = body?.action;
  const sitekey = body?.sitekey;

  if (!action || !['rotate', 'toggle', 'delete'].includes(action)) {
    res.status(400).json({ error: 'invalid-action' });
    return;
  }
  if (!sitekey || typeof sitekey !== 'string') {
    res.status(400).json({ error: 'missing-sitekey' });
    return;
  }

  try {
    const sql = getSql();

    if (action === 'rotate') {
      // Generate a brand-new secret. The old one is immediately invalid.
      const newSecret = randomBytes(16).toString('hex');
      const rows = await sql`
        UPDATE sites
        SET secret = ${newSecret}
        WHERE sitekey = ${sitekey}
        RETURNING domain
      `;
      const row = (rows as unknown as Array<{ domain: string }>)[0];
      if (!row) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.status(200).json({ secret: newSecret, domain: row.domain });
      return;
    }

    if (action === 'toggle') {
      const rows = await sql`
        UPDATE sites SET active = NOT active
        WHERE sitekey = ${sitekey}
        RETURNING active
      `;
      const row = (rows as unknown as Array<{ active: boolean }>)[0];
      if (!row) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.status(200).json({ active: row.active });
      return;
    }

    if (action === 'delete') {
      const rows = await sql`
        DELETE FROM sites WHERE sitekey = ${sitekey} RETURNING sitekey
      `;
      if ((rows as unknown as Array<unknown>).length === 0) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      res.status(200).json({ deleted: true, sitekey });
      return;
    }
  } catch (err) {
    console.error('site-manage error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
