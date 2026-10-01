import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Stateless logout. Admin sessions are JWTs with a 12h TTL; the client is
 * responsible for discarding the token. This endpoint exists so frontends
 * have a predictable URL to POST to.
 */
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

  res.status(200).json({ ok: true });
}
