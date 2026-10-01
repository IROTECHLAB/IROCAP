import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runCleanup } from '../lib/cleanup.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ ok: false, error: 'cron-secret-not-configured' });
    return;
  }

  const auth = req.headers.authorization ?? '';
  const headerSecret = req.headers['x-cron-secret'];
  const headerSecretStr = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;

  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : '';

  const authorized =
    (typeof bearer === 'string' && bearer === cronSecret) ||
    (typeof headerSecretStr === 'string' && headerSecretStr === cronSecret);

  if (!authorized) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const deleted = await runCleanup();
    res.status(200).json({ ok: true, deleted });
  } catch (err) {
    console.error('cleanup error:', err);
    res.status(500).json({ ok: false, error: 'internal-error' });
  }
}
