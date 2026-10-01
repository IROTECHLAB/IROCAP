import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../lib/db.js';
import { signToken } from '../lib/tokens.js';
import { scoreSignals, type IrocapSignals } from '../lib/scoring.js';
import { maybeCleanup } from '../lib/cleanup.js';
import { validateChallengeSignature } from '../lib/challenge-sign.js';
import { extractTrustedSignals, scoreTrustedSignals } from '../lib/trusted.js';

interface VerifyBody {
  challenge?: string;
  nonce?: number;
  hash?: string;
  issuedAt?: number;
  sig?: string;
  signals?: Partial<IrocapSignals>;
}

interface ChallengeRow {
  id: string;
  difficulty: number;
  sitekey: string;
  solved: boolean;
  created_at: string;
  issued_at: number | null;
}

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

function normalizeSignals(raw: Partial<IrocapSignals> | undefined): IrocapSignals {
  return {
    webdriver: Boolean(raw?.webdriver),
    touchSupport: Boolean(raw?.touchSupport),
    mouseMovements: Number(raw?.mouseMovements ?? 0),
    keyPresses: Number(raw?.keyPresses ?? 0),
    timeToInteract: Number(raw?.timeToInteract ?? 0),
    canvasHash: String(raw?.canvasHash ?? ''),
    webglVendor: String(raw?.webglVendor ?? ''),
    screenSize: String(raw?.screenSize ?? ''),
    colorDepth: Number(raw?.colorDepth ?? 0),
    language: String(raw?.language ?? ''),
    timezone: String(raw?.timezone ?? ''),
    hardwareConcurrency: Number(raw?.hardwareConcurrency ?? 0),
    method: raw?.method === 'webcrypto' ? 'webcrypto' : raw?.method === 'js' ? 'js' : 'wasm',
    solveMs: Number(raw?.solveMs ?? 0),
    pluginsCount: Number(raw?.pluginsCount ?? -1),
  };
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
      | VerifyBody
      | undefined;

    const challenge = body?.challenge;
    const nonce = body?.nonce;
    const hash = body?.hash;
    const issuedAt = body?.issuedAt;
    const sig = body?.sig;

    if (
      typeof challenge !== 'string' ||
      typeof nonce !== 'number' ||
      typeof hash !== 'string' ||
      typeof issuedAt !== 'number' ||
      typeof sig !== 'string'
    ) {
      res.status(400).json({ error: 'invalid-payload' });
      return;
    }

    const sql = getSql();

    // --- 1. Look up the challenge (needed for difficulty + sitekey). --------
    const rows = (await sql`
      SELECT id, difficulty, sitekey, solved, created_at, issued_at
      FROM challenges WHERE id = ${challenge} LIMIT 1
    `) as unknown as ChallengeRow[];

    const row = rows[0];
    if (!row) {
      res.status(400).json({ error: 'invalid-challenge' });
      return;
    }

    // --- 2. Validate the HMAC signature. -----------------------------------
    const sigCheck = validateChallengeSignature(
      challenge,
      row.difficulty,
      issuedAt,
      sig,
    );
    if (!sigCheck.ok) {
      res.status(400).json({ error: sigCheck.reason ?? 'bad-sig' });
      return;
    }

    // --- 3. Fetch the site's domain for Origin/Referer matching. -----------
    const siteRows = (await sql`
      SELECT sitekey, domain, active FROM sites WHERE sitekey = ${row.sitekey} LIMIT 1
    `) as unknown as SiteRow[];
    const site = siteRows[0];
    if (!site || !site.active) {
      res.status(404).json({ error: 'unknown-sitekey' });
      return;
    }

    // --- 4. Atomic claim: burns the challenge on the first attempt. -------
    const claimed = (await sql`
      UPDATE challenges SET solved = TRUE
      WHERE id = ${challenge}
        AND solved = FALSE
        AND created_at > NOW() - INTERVAL '5 minutes'
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    if (claimed.length === 0) {
      res.status(400).json({ error: 'replay-or-expired' });
      return;
    }

    // --- 5. Verify the PoW hash. ------------------------------------------
    const expectedPrefix = '0'.repeat(row.difficulty);
    if (!hash.startsWith(expectedPrefix)) {
      res.status(400).json({ error: 'invalid-solution' });
      return;
    }

    // --- 6. Trusted signals (server-observed). ---------------------------
    const trusted = extractTrustedSignals(req, site.domain, row.created_at);
    const verdict = scoreTrustedSignals(trusted);

    if (verdict.botDetected) {
      // Log it, but return the same generic error a solver would see.
      console.warn('[irocap] bot rejected', {
        sitekey: row.sitekey,
        ip: clientIp(req),
        reasons: verdict.reasons,
        ua: trusted.userAgent.slice(0, 120),
      });
      res.status(403).json({ error: 'bot-detected' });
      return;
    }

    // --- 7. Combine with client-claimed behavioral score. ----------------
    const signals = normalizeSignals(body?.signals);
    const behavioral = scoreSignals(signals);

    // Trusted signals weigh more; use the minimum so a spoofed behavioral
    // score can't raise a bad trusted score.
    const finalScore = Math.min(verdict.score, behavioral);

    // --- 8. Issue JWT, store token. --------------------------------------
    const token = signToken({
      sitekey: row.sitekey,
      score: finalScore,
      challenge,
    });

    const ip = clientIp(req);

    await sql`
      INSERT INTO irocap_tokens (token, sitekey, score, ip, used)
      VALUES (${token}, ${row.sitekey}, ${finalScore}, ${ip}::inet, FALSE)
    `;

    res.status(200).json({ token, score: finalScore });
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ error: 'internal-error' });
  }
}
