import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../lib/db.js';
import { verifyToken } from '../lib/tokens.js';

interface SiteVerifyBody {
  secret?: string;
  response?: string;
  remoteip?: string;
}

interface SiteRow {
  sitekey: string;
  active: boolean;
}

function fail(res: VercelResponse, status: number, code: string): void {
  res.status(status).json({ success: false, 'error-codes': [code] });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    fail(res, 405, 'method-not-allowed');
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as
      | SiteVerifyBody
      | undefined;

    const secret = body?.secret;
    const response = body?.response;

    if (!secret || typeof secret !== 'string') {
      fail(res, 400, 'invalid-secret');
      return;
    }
    if (!response || typeof response !== 'string') {
      fail(res, 400, 'invalid-token');
      return;
    }

    const sql = getSql();

    const siteRowsRaw = await sql`
      SELECT sitekey, active FROM sites WHERE secret = ${secret} LIMIT 1
    `;
    const siteRows = siteRowsRaw as unknown as SiteRow[];

    const site = siteRows[0];
    if (!site || !site.active) {
      fail(res, 403, 'invalid-secret');
      return;
    }

    const payload = verifyToken(response);
    if (!payload) {
      fail(res, 400, 'expired');
      return;
    }

    if (payload.sitekey !== site.sitekey) {
      fail(res, 400, 'invalid-token');
      return;
    }

    const consumedRaw = await sql`
      UPDATE irocap_tokens SET used = TRUE
      WHERE token = ${response} AND used = FALSE
      RETURNING score, sitekey, created_at
    `;
    const consumed = consumedRaw as unknown as Array<{
      score: number;
      sitekey: string;
      created_at: string;
    }>;

    if (consumed.length === 0) {
      const existsRaw = await sql`
        SELECT 1 FROM irocap_tokens WHERE token = ${response} LIMIT 1
      `;
      const exists = existsRaw as unknown as Array<Record<string, unknown>>;
      if (exists.length > 0) {
        fail(res, 400, 'already-used');
        return;
      }
      fail(res, 400, 'invalid-token');
      return;
    }

    const row = consumed[0]!;
    res.status(200).json({
      success: true,
      score: row.score,
      sitekey: row.sitekey,
      challenge_ts: row.created_at,
    });
  } catch (err) {
    console.error('siteverify error:', err);
    res.status(500).json({ success: false, 'error-codes': ['internal-error'] });
  }
}
