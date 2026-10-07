import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../lib/db.js';
import { verifyPassword, signAdminSession, ADMIN_SESSION_TTL } from '../lib/admin.js';
import { checkRateLimit } from '../lib/rate-limit.js';

interface LoginBody {
  email?: string;
  password?: string;
}

interface AdminRow {
  id: number;
  email: string;
  password_hash: string;
  password_salt: string;
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

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  try {
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as
      | LoginBody
      | undefined;

    const email = (body?.email ?? '').trim().toLowerCase();
    const password = body?.password ?? '';

    if (!email || !password) {
      res.status(400).json({ error: 'missing-credentials' });
      return;
    }

    // Throttle brute-force attempts on two axes: IP-based and email-based.
    // IP-based catches single-source attacks; email-based catches distributed
    // attacks that rotate IPs but target the same account.
    const ip = clientIp(req);
    const ipRl = await checkRateLimit(ip, 'admin-login', 10);
    if (!ipRl.allowed) {
      res.status(429).json({ error: 'rate-limited', retry_after: 60 });
      return;
    }

    const emailKey = 'admin-login:email:' + email;
    const emailRl = await checkRateLimit('0.0.0.0', emailKey, 5);
    if (!emailRl.allowed) {
      res.status(429).json({ error: 'rate-limited', retry_after: 60 });
      return;
    }

    const sql = getSql();
    const rows = (await sql`
      SELECT id, email, password_hash, password_salt, active
      FROM admin_users WHERE email = ${email} LIMIT 1
    `) as AdminRow[];

    const user = rows[0];

    // Always run a verify to equalize timing between unknown user and wrong
    // password. Use dummy values if the user doesn't exist.
    const ok = await verifyPassword(
      password,
      user?.password_hash ?? '00'.repeat(64),
      user?.password_salt ?? '00'.repeat(16),
    );

    if (!user || !user.active || !ok) {
      res.status(401).json({ error: 'invalid-credentials' });
      return;
    }

    const token = signAdminSession({
      sub: user.id,
      email: user.email,
      role: 'admin',
    });

    res.status(200).json({
      token,
      email: user.email,
      expires_in: ADMIN_SESSION_TTL,
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
