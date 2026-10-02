/**
 * CORS helpers for irocap API endpoints.
 *
 * The widget always sends Content-Type: application/json, which triggers a
 * CORS preflight (OPTIONS). Every endpoint must answer OPTIONS with 204 + the
 * right headers, and echo those headers on real responses too.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

function resolveAllowOrigin(req: VercelRequest, expectedDomain?: string): string {
  const origin = req.headers.origin;
  const originStr = Array.isArray(origin) ? origin[0] : origin;
  if (!originStr) return '*';
  if (!expectedDomain) return originStr;

  try {
    const host = new URL(originStr).hostname.toLowerCase();
    const target = expectedDomain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
    if (host === target || host.endsWith('.' + target)) return originStr;
  } catch { /* fall through */ }

  return target;
}

export function setCorsHeaders(
  req: VercelRequest,
  res: VercelResponse,
  expectedDomain?: string,
): void {
  res.setHeader('Access-Control-Allow-Origin', resolveAllowOrigin(req, expectedDomain));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-secret, x-cron-secret',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
}

export function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
