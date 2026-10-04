import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSql } from '../lib/db.js';
import { signToken } from '../lib/tokens.js';
import { scoreSignals, type IrocapSignals } from '../lib/scoring.js';
import { maybeCleanup } from '../lib/cleanup.js';
import { validateChallengeSignature } from '../lib/challenge-sign.js';
import { extractTrustedSignals, scoreTrustedSignals } from '../lib/trusted.js';
import { checkConsistency } from '../lib/consistency.js';
import { fingerprint } from '../lib/fingerprint.js';
import { analyzeBehavior } from '../lib/behavioral.js';
import { getASN, isDatacenterASN } from '../lib/asn.js';
import { scoreEnvSignals, type EnvSignals } from '../lib/env-signals.js';
import { setCorsHeaders, handlePreflight } from '../lib/cors.js';

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
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

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

    const consistency = checkConsistency(req, {
      language: signals.language,
      timezone: signals.timezone,
      screenSize: signals.screenSize,
      colorDepth: signals.colorDepth,
    });

    const challengeAgeMs = Date.now() - new Date(row.created_at).getTime();
    const behavior = analyzeBehavior(signals.events, challengeAgeMs);

    if (consistency.reasons.length > 0) {
      console.warn('[irocap] consistency flags', { sitekey: row.sitekey, reasons: consistency.reasons });
    }
    if (behavior.reasons.length > 0) {
      console.warn('[irocap] behavior flags', { sitekey: row.sitekey, reasons: behavior.reasons });
    }

    const envVerdict = scoreEnvSignals(signals.env as EnvSignals | undefined);
    if (envVerdict.reasons.length > 0) {
      console.warn('[irocap] env flags', {
        sitekey: row.sitekey,
        reasons: envVerdict.reasons,
        headlessMarkers: envVerdict.headlessMarkerCount,
      });
    }

    let finalScore = Math.min(
      verdict.score,
      consistency.score,
      behavior.score,
      envVerdict.score,
      behavioral,
    );

    // ASN blocking
    const ip = clientIp(req);
    try {
      const asnInfo = await getASN(ip);
      if (isDatacenterASN(asnInfo.asn)) {
        finalScore = Math.min(finalScore, 0.15);
        console.warn('[irocap] datacenter asn', {
          sitekey: row.sitekey, ip, asn: asnInfo.asn, org: asnInfo.org,
        });
      }
    } catch { /* non-fatal */ }

    // Fingerprint reputation
    const fp = fingerprint(signals);
    const isGoodFp = finalScore >= 0.5;
    let fpReputation = 0.5;
    try {
      const fpRows = await sql`
        INSERT INTO fingerprints (fp, total_hits, good_hits, bad_hits, reputation)
        VALUES (
          ${fp}, 1,
          ${isGoodFp ? 1 : 0},
          ${isGoodFp ? 0 : 1},
          ${finalScore}
        )
        ON CONFLICT (fp) DO UPDATE SET
          last_seen = NOW(),
          total_hits = fingerprints.total_hits + 1,
          good_hits = fingerprints.good_hits + ${isGoodFp ? 1 : 0},
          bad_hits = fingerprints.bad_hits + ${isGoodFp ? 0 : 1},
          reputation = (
            (fingerprints.good_hits + ${isGoodFp ? 1 : 0})::float /
            GREATEST(fingerprints.total_hits + 1, 1)
          )
        RETURNING reputation
      ` as unknown as Array<{ reputation: number }>;
      fpReputation = fpRows[0]?.reputation ?? 0.5;
    } catch (e) {
      console.warn('[irocap] fingerprint upsert failed', e);
    }

    if (fpReputation < 0.3) {
      finalScore = Math.min(finalScore, fpReputation);
    }

    // IP reputation
    const isGoodIp = finalScore >= 0.5;
    try {
      await sql`
        INSERT INTO ip_reputation (ip, total_solves, good_solves, bad_solves, reputation)
        VALUES (
          ${ip}::inet, 1,
          ${isGoodIp ? 1 : 0},
          ${isGoodIp ? 0 : 1},
          ${finalScore}
        )
        ON CONFLICT (ip) DO UPDATE SET
          last_seen = NOW(),
          total_solves = ip_reputation.total_solves + 1,
          good_solves = ip_reputation.good_solves + ${isGoodIp ? 1 : 0},
          bad_solves = ip_reputation.bad_solves + ${isGoodIp ? 0 : 1},
          reputation = (
            (ip_reputation.good_solves + ${isGoodIp ? 1 : 0})::float /
            GREATEST(ip_reputation.total_solves + 1, 1)
          )
      `;
    } catch (e) {
      console.warn('[irocap] ip reputation upsert failed', e);
    }

    // --- 8. Issue JWT, store token. --------------------------------------
    const token = signToken({
      sitekey: row.sitekey,
      score: finalScore,
      challenge,
    });

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
