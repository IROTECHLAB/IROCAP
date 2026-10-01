import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { getSql } from '../lib/db.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { maybeCleanup } from '../lib/cleanup.js';
import { signChallenge } from '../lib/challenge-sign.js';

const BASE_DIFFICULTY = 5;

interface SiteRow {
  sitekey: string;
  domain: string;
  active: boolean;
}

function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? '0.0.0.0';
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  maybeCleanup();

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as
      | { sitekey?: string }
      | undefined;
    const sitekey = body?.sitekey;

    if (!sitekey || typeof sitekey !== 'string') {
      res.status(400).json({ error: 'missing-sitekey' });
      return;
    }

    const sql = getSql();
    const siteRows = (await sql`
      SELECT sitekey, domain, active FROM sites WHERE sitekey = ${sitekey} LIMIT 1
    `) as unknown as SiteRow[];

    const site = siteRows[0];
    if (!site || !site.active) {
      res.status(404).json({ error: 'unknown-sitekey' });
      return;
    }

    const ip = clientIp(req);

    const rl = await checkRateLimit(ip, sitekey, 60);
    if (!rl.allowed) {
      res.status(429).json({ error: 'rate-limited', retry_after: 60, limit: rl.limit });
      return;
    }

    // Escalate difficulty based on recent activity from this sitekey.
    const recent = (await sql`
      SELECT COUNT(*)::int AS n
      FROM challenges
      WHERE sitekey = ${sitekey}
        AND created_at > NOW() - INTERVAL '1 minute'
    `) as unknown as Array<{ n: number }>;
    const recentCount = recent[0]?.n ?? 0;

    let difficulty = BASE_DIFFICULTY;
    if (recentCount > 100) difficulty = 6;
    if (recentCount > 200) difficulty = 7;
    if (recentCount > 400) difficulty = 8;

    const challenge = randomBytes(24).toString('hex'); // 48 hex chars
    const { issuedAt, sig } = signChallenge(challenge, difficulty);

    await sql`
      INSERT INTO challenges (id, difficulty, sitekey, solved, issued_at, signature)
      VALUES (${challenge}, ${difficulty}, ${sitekey}, FALSE, ${issuedAt}, ${sig})
    `;

    res.status(200).json({
      challenge,
      difficulty,
      issuedAt,
      sig,
    });
  } catch (err) {
    console.error('challenge error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
