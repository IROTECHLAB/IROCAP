/**
 * End-to-end test for irocap.
 *
 * Requires a running deployment (or `vercel dev`) plus DATABASE_URL,
 * IROCAP_BASE_URL, IROCAP_ADMIN_EMAIL, and IROCAP_ADMIN_PASSWORD.
 *
 * Usage:
 *   IROCAP_BASE_URL=http://localhost:3000 \
 *   IROCAP_ADMIN_EMAIL=admin@example.com \
 *   IROCAP_ADMIN_PASSWORD=... \
 *   pnpm tsx scripts/e2e.ts
 */
import 'dotenv/config';
import { sha256 } from 'hash-wasm';
import { randomBytes } from 'node:crypto';

const BASE = process.env.IROCAP_BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.IROCAP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.IROCAP_ADMIN_PASSWORD;

function log(step: string, msg: string): void {
  console.log(`[${step}] ${msg}`);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function solve(
  challenge: string,
  difficulty: number,
): Promise<{ nonce: number; hash: string; solveMs: number }> {
  const prefix = '0'.repeat(difficulty);
  const start = Date.now();
  let nonce = 0;
  for (;;) {
    const h = await sha256(challenge + nonce);
    if (h.startsWith(prefix)) {
      return { nonce, hash: h, solveMs: Date.now() - start };
    }
    nonce++;
    if (Date.now() - start > 60_000) throw new Error('solve timeout');
  }
}

async function main(): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    fail('IROCAP_ADMIN_EMAIL and IROCAP_ADMIN_PASSWORD must be set');
  }

  log('login', `base=${BASE} email=${ADMIN_EMAIL}`);
  const loginRes = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    fail('login failed: ' + loginRes.status + ' ' + (await loginRes.text()));
  }
  const login = (await loginRes.json()) as { token: string };
  log('login', `session acquired (expires_in=${(login as unknown as { expires_in: number }).expires_in ?? 'n/a'}s)`);

  log('register', 'creating test site');
  const domain = 'e2e-' + randomBytes(4).toString('hex') + '.test';
  const regRes = await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + login.token,
    },
    body: JSON.stringify({ domain }),
  });
  if (!regRes.ok) {
    fail('register failed: ' + regRes.status + ' ' + (await regRes.text()));
  }
  const reg = (await regRes.json()) as { sitekey: string; secret: string };
  log('register', `sitekey=${reg.sitekey}`);

  log('challenge', 'requesting');
  const chRes = await fetch(BASE + '/api/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sitekey: reg.sitekey }),
  });
  if (!chRes.ok) {
    fail('challenge failed: ' + chRes.status + ' ' + (await chRes.text()));
  }
  const ch = (await chRes.json()) as { challenge: string; difficulty: number };
  log('challenge', `id=${ch.challenge.slice(0, 12)}… difficulty=${ch.difficulty}`);

  log('solve', 'computing PoW');
  const sol = await solve(ch.challenge, ch.difficulty);
  log('solve', `nonce=${sol.nonce} ms=${sol.solveMs}`);

  log('verify', 'submitting solution');
  const verRes = await fetch(BASE + '/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge: ch.challenge,
      nonce: sol.nonce,
      hash: sol.hash,
      signals: {
        webdriver: false,
        touchSupport: true,
        mouseMovements: 42,
        keyPresses: 7,
        timeToInteract: 1200,
        canvasHash: 'deadbeef',
        webglVendor: 'test',
        screenSize: '1920x1080',
        colorDepth: 24,
        language: 'en-US',
        timezone: 'UTC',
        hardwareConcurrency: 8,
        method: 'wasm',
        solveMs: sol.solveMs,
      },
    }),
  });
  if (!verRes.ok) {
    fail('verify failed: ' + verRes.status + ' ' + (await verRes.text()));
  }
  const ver = (await verRes.json()) as { token: string; score: number };
  log('verify', `score=${ver.score} token=${ver.token.slice(0, 24)}…`);

  log('siteverify', 'first call (should succeed)');
  const sv1 = await fetch(BASE + '/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: reg.secret, response: ver.token }),
  });
  const sv1Body = (await sv1.json()) as Record<string, unknown>;
  if (!sv1.ok || sv1Body.success !== true) {
    fail('siteverify #1 failed: ' + JSON.stringify(sv1Body));
  }
  log('siteverify', `success=true score=${sv1Body.score}`);

  log('siteverify', 'second call (should fail with already-used)');
  const sv2 = await fetch(BASE + '/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: reg.secret, response: ver.token }),
  });
  const sv2Body = (await sv2.json()) as Record<string, unknown>;
  const codes = (sv2Body['error-codes'] as string[] | undefined) || [];
  if (sv2Body.success !== false || !codes.includes('already-used')) {
    fail('siteverify #2 expected already-used, got: ' + JSON.stringify(sv2Body));
  }
  log('siteverify', 'already-used confirmed');

  console.log('\n✓ e2e passed');
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
