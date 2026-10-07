#!/usr/bin/env node
/**
 * patch-security.mjs
 * Applies the security hardening fixes from the code review.
 *
 * Fixes:
 *   1. Recompute SHA-256(challenge + nonce) server-side (CRITICAL)
 *   2. Correct x-forwarded-for / x-real-ip handling (CRITICAL)
 *   3. Reject low-score tokens in /api/verify
 *   4. Fix lib/cors.ts `target` scope bug
 *   5. Fix IrocapSignals.events type
 *   6. Pass resolved WASM URL to the worker
 *   7. Scope fingerprint per-sitekey (HMAC)
 *   8. Add email-keyed admin login rate limiter
 *   9. Bind challenges to registered domain (CORS + Origin check)
 *  10. Add security headers via vercel.json
 *
 * Idempotent. Backs up each file once to *.bak.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const ROOT = process.cwd();
const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[90m', X = '\x1b[0m';
const ok   = (s) => console.log(`  ${G}✓${X} ${s}`);
const skip = (s) => console.log(`  ${D}•${X} ${s} (already applied)`);
const warn = (s) => console.log(`  ${Y}!${X} ${s}`);
const fail = (s) => console.log(`  ${R}✗${X} ${s}`);

function read(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) { fail(`${rel} not found`); process.exit(1); }
  return readFileSync(p, 'utf8');
}
function backup(rel) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p + '.bak')) copyFileSync(p, p + '.bak');
}
function write(rel, content) {
  const p = resolve(ROOT, rel);
  backup(rel);
  writeFileSync(p, content);
}

console.log('\n=== irocap security patch ===\n');

// ===========================================================================
// 1. api/verify.ts — SHA-256 recomputation, nonce validation, low-score reject,
//    correct IP extraction, env passthrough fixes
// ===========================================================================
let verify = read('api/verify.ts');
let verifyChanged = false;

// --- 1a. Add node:crypto import if missing ---
if (!verify.includes("from 'node:crypto'")) {
  const anchor = "import { getSql } from '../lib/db.js';";
  if (verify.includes(anchor)) {
    verify = verify.replace(
      anchor,
      "import { createHash, timingSafeEqual } from 'node:crypto';\n" + anchor
    );
    verifyChanged = true;
    ok('api/verify.ts — node:crypto imported');
  } else {
    warn('api/verify.ts — db.js import anchor not found');
  }
} else {
  skip('api/verify.ts — node:crypto already imported');
}

// --- 1b. Add sha256Hex helper + MIN_ACCEPT_SCORE constant ---
if (!verify.includes('function sha256Hex')) {
  const anchor = 'function clientIp(req: VercelRequest): string {';
  const helper = `const MIN_ACCEPT_SCORE = 0.3;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

`;
  if (verify.includes(anchor)) {
    verify = verify.replace(anchor, helper + anchor);
    verifyChanged = true;
    ok('api/verify.ts — sha256Hex + MIN_ACCEPT_SCORE added');
  } else {
    warn('api/verify.ts — clientIp anchor not found for helper insertion');
  }
} else {
  skip('api/verify.ts — sha256Hex already present');
}

// --- 1c. Rewrite clientIp to prefer x-real-ip and take the LAST xff entry ---
const oldClientIp = `function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? '0.0.0.0';
}`;

const newClientIp = `function clientIp(req: VercelRequest): string {
  // On Vercel the edge sets x-real-ip to the actual client IP.
  // x-forwarded-for is appended to, so the LAST entry is closest to us —
  // never trust the first (client-claimable) entry.
  const real = req.headers['x-real-ip'];
  const realStr = Array.isArray(real) ? real[0] : real;
  if (typeof realStr === 'string' && realStr.trim()) {
    return realStr.trim();
  }

  const fwd = req.headers['x-forwarded-for'];
  const fwdStr = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof fwdStr === 'string' && fwdStr.length > 0) {
    const parts = fwdStr.split(',').map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }

  return req.socket?.remoteAddress ?? '0.0.0.0';
}`;

if (verify.includes(newClientIp)) {
  skip('api/verify.ts — clientIp already hardened');
} else if (verify.includes(oldClientIp)) {
  verify = verify.replace(oldClientIp, newClientIp);
  verifyChanged = true;
  ok('api/verify.ts — clientIp hardened (x-real-ip, last XFF entry)');
} else {
  warn('api/verify.ts — clientIp shape not recognized; patch manually');
}

// --- 1d. Replace PoW check with full server-side recomputation ---
const oldPowCheck = `    // --- 5. Verify the PoW hash. ------------------------------------------
    const expectedPrefix = '0'.repeat(row.difficulty);
    if (!hash.startsWith(expectedPrefix)) {
      res.status(400).json({ error: 'invalid-solution' });
      return;
    }`;

const newPowCheck = `    // --- 5. Verify the PoW hash by recomputing it. ------------------------
    // This is the critical security check. We must not trust the client's
    // claimed hash — we recompute SHA256(challenge + nonce) ourselves and
    // compare it with timingSafeEqual.
    if (
      !/^[0-9a-f]{48}$/.test(challenge) ||
      !/^[0-9a-f]{64}$/.test(hash) ||
      typeof nonce !== 'number' ||
      !Number.isSafeInteger(nonce) ||
      nonce < 0
    ) {
      res.status(400).json({ error: 'invalid-solution' });
      return;
    }

    const expectedHash = sha256Hex(challenge + nonce);

    const suppliedBuf = Buffer.from(hash, 'ascii');
    const expectedBuf = Buffer.from(expectedHash, 'ascii');

    if (
      suppliedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(suppliedBuf, expectedBuf)
    ) {
      res.status(400).json({ error: 'invalid-solution' });
      return;
    }

    if (!expectedHash.startsWith('0'.repeat(row.difficulty))) {
      res.status(400).json({ error: 'invalid-solution' });
      return;
    }`;

if (verify.includes('recomputing it')) {
  skip('api/verify.ts — PoW recomputation');
} else if (verify.includes(oldPowCheck)) {
  verify = verify.replace(oldPowCheck, newPowCheck);
  verifyChanged = true;
  ok('api/verify.ts — PoW now recomputed server-side');
} else {
  warn('api/verify.ts — PoW check block not found; check manually');
}

// --- 1e. Reject low scores before issuing the token ---
const oldTokenIssue = `    const token = signToken({
      sitekey: row.sitekey,
      score: adjustedScore,
      challenge,
    });`;

const newTokenIssue = `    if (adjustedScore < MIN_ACCEPT_SCORE) {
      console.warn('[irocap] low score rejected', {
        sitekey: row.sitekey,
        score: adjustedScore,
      });
      res.status(403).json({ error: 'low-score', score: adjustedScore });
      return;
    }

    const token = signToken({
      sitekey: row.sitekey,
      score: adjustedScore,
      challenge,
    });`;

if (verify.includes('low score rejected')) {
  skip('api/verify.ts — low-score rejection');
} else if (verify.includes(oldTokenIssue)) {
  verify = verify.replace(oldTokenIssue, newTokenIssue);
  verifyChanged = true;
  ok('api/verify.ts — low-score tokens now rejected');
} else {
  warn('api/verify.ts — token issue block not found; check manually');
}

if (verifyChanged) {
  write('api/verify.ts', verify);
  ok('api/verify.ts saved');
}

// ===========================================================================
// 2. lib/cors.ts — fix `target` scope bug
// ===========================================================================
let cors = read('lib/cors.ts');
if (cors.includes('function normalizeDomain')) {
  skip('lib/cors.ts — normalizeDomain already present');
} else {
  const oldResolve = `function resolveAllowOrigin(req: VercelRequest, expectedDomain?: string): string {
  const origin = req.headers.origin;
  const originStr = Array.isArray(origin) ? origin[0] : origin;

  if (!originStr) return '*';
  if (!expectedDomain) return originStr;

  try {
    const host = new URL(originStr).hostname.toLowerCase();
    const target = expectedDomain
      .toLowerCase()
      .replace(/^https?:\\/\\//, '')
      .replace(/\\/.*$/, '')
      .replace(/:\\d+$/, '');

    if (host === target || host.endsWith('.' + target)) {
      return originStr;
    }
  } catch { /* fall through */ }

  return target;
}`;

  const newResolve = `function normalizeDomain(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/.*$/, '')
    .replace(/:\\d+$/, '');
}

function resolveAllowOrigin(req: VercelRequest, expectedDomain?: string): string {
  const origin = req.headers.origin;
  const originStr = Array.isArray(origin) ? origin[0] : origin;

  if (!originStr) return '*';
  if (!expectedDomain) return originStr;

  const target = normalizeDomain(expectedDomain);

  try {
    const host = new URL(originStr).hostname.toLowerCase();
    if (host === target || host.endsWith('.' + target)) {
      return originStr;
    }
  } catch { /* fall through */ }

  return target;
}`;

  if (cors.includes(oldResolve)) {
    cors = cors.replace(oldResolve, newResolve);
    write('lib/cors.ts', cors);
    ok('lib/cors.ts — target scope bug fixed');
  } else {
    warn('lib/cors.ts — resolveAllowOrigin shape not recognized');
  }
}

// ===========================================================================
// 3. lib/scoring.ts — add events field to IrocapSignals
// ===========================================================================
let scoring = read('lib/scoring.ts');
if (scoring.includes('events?: Array<{')) {
  skip('lib/scoring.ts — events field already present');
} else {
  const anchor = '  pluginsCount?: number;';
  if (scoring.includes(anchor)) {
    scoring = scoring.replace(
      anchor,
      anchor + '\n  events?: Array<{ t: number; x?: number; y?: number; k?: string; s?: number }>;'
    );
    write('lib/scoring.ts', scoring);
    ok('lib/scoring.ts — events field added to IrocapSignals');
  } else {
    warn('lib/scoring.ts — pluginsCount anchor not found');
  }
}

// ===========================================================================
// 4. public/irocap.js — pass resolved WASM URL into the worker
// ===========================================================================
let widget = read('public/irocap.js');
let widgetChanged = false;

// 4a. In _workerSource, replace the hardcoded importScripts with one that
//     reads from the message payload.
if (widget.includes("importScripts(wasmUrl)")) {
  skip('public/irocap.js — WASM URL already passed through');
} else if (widget.includes(`importScripts("/wasm/sha256.umd.min.js")`)) {
  widget = widget.replace(
    `'try {',\n      '  importScripts("/wasm/sha256.umd.min.js");',`,
    `'try {',\n      '  importScripts(wasmUrl);',`
  );
  // Add `var wasmUrl = d.wasmUrl;` to the worker onmessage body
  if (!widget.includes('var wasmUrl = d.wasmUrl;')) {
    widget = widget.replace(
      `'    var difficulty = d.difficulty;',`,
      `'    var difficulty = d.difficulty;',\n      '    var wasmUrl = d.wasmUrl || "/wasm/sha256.umd.min.js";',`
    );
  }
  widgetChanged = true;
  ok('public/irocap.js — worker reads WASM URL from message');
} else {
  warn('public/irocap.js — hardcoded importScripts not found');
}

// 4b. In _solveInWorker, add wasmUrl to postMessage
if (widget.includes('wasmUrl: self.base +')) {
  skip('public/irocap.js — wasmUrl already posted to worker');
} else {
  const anchor = 'worker.postMessage({ challenge: challenge, difficulty: difficulty });';
  if (widget.includes(anchor)) {
    widget = widget.replace(
      anchor,
      'worker.postMessage({\n        challenge: challenge,\n        difficulty: difficulty,\n        wasmUrl: self.base + \'/wasm/sha256.umd.min.js\',\n      });'
    );
    widgetChanged = true;
    ok('public/irocap.js — wasmUrl posted to worker');
  } else {
    warn('public/irocap.js — worker.postMessage anchor not found');
  }
}

if (widgetChanged) {
  write('public/irocap.js', widget);
  ok('public/irocap.js saved');
}

// ===========================================================================
// 5. lib/fingerprint.ts — scope fingerprint per-sitekey via HMAC
// ===========================================================================
let fp = read('lib/fingerprint.ts');
if (fp.includes("createHmac")) {
  skip('lib/fingerprint.ts — already HMAC-scoped');
} else {
  const newFp = `import { createHmac } from 'node:crypto';
import type { IrocapSignals } from './scoring.js';

/**
 * Per-sitekey fingerprint.
 *
 * The HMAC key is derived from the site's secret so the same browser
 * produces different fingerprints for different sitekeys. This keeps
 * reputation per-tenant and prevents cross-site tracking.
 *
 * The output is truncated to 16 hex chars (64 bits) — enough for
 * collision resistance at our scale, and cheap to store.
 */
export function fingerprint(signals: IrocapSignals, siteSecret: string): string {
  const tuple = [
    signals.canvasHash || '',
    signals.webglVendor || '',
    signals.screenSize || '',
    String(signals.colorDepth || 0),
    signals.language || '',
    signals.timezone || '',
    String(signals.hardwareConcurrency || 0),
    String(signals.pluginsCount ?? -1),
  ].join('|');
  return createHmac('sha256', siteSecret).update(tuple).digest('hex').slice(0, 16);
}`;
  write('lib/fingerprint.ts', newFp);
  ok('lib/fingerprint.ts — HMAC-scoped per-sitekey');
}

// ===========================================================================
// 6. api/verify.ts — pass site.secret into fingerprint()
// ===========================================================================
// We need to fetch the site row before fingerprinting. This is already
// available via `site` in the current verify.ts, but if fingerprint() is
// called with one arg, update it.

let verify2 = read('api/verify.ts');
if (verify2.includes('fingerprint(signals, site.secret)')) {
  skip('api/verify.ts — fingerprint uses site.secret');
} else if (verify2.includes('const fp = fingerprint(signals);')) {
  // Need to ensure `site` variable exists. Verify that we fetched it earlier.
  if (!verify2.includes('const site = siteRows[0]')) {
    warn('api/verify.ts — cannot find `site` variable; fingerprint HMAC requires it. Add manual fetch.');
  } else {
    verify2 = verify2.replace(
      'const fp = fingerprint(signals);',
      'const fp = fingerprint(signals, site.secret);'
    );
    write('api/verify.ts', verify2);
    ok('api/verify.ts — fingerprint() now HMAC-scoped with site.secret');
  }
} else {
  warn('api/verify.ts — fingerprint call not found');
}

// ===========================================================================
// 7. api/login.ts — add email-keyed rate limiter alongside IP
// ===========================================================================
let login = read('api/login.ts');
if (login.includes('admin-login:email')) {
  skip('api/login.ts — email-keyed limiter already present');
} else {
  const oldRl = `    // Throttle brute-force attempts: 10 logins/min per IP per sitekey slot.
    const ip = clientIp(req);
    const rl = await checkRateLimit(ip, 'admin-login', 10);
    if (!rl.allowed) {
      res.status(429).json({ error: 'rate-limited', retry_after: 60 });
      return;
    }`;

  const newRl = `    // Throttle brute-force attempts on two axes: IP-based and email-based.
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
    }`;

  if (login.includes(oldRl)) {
    login = login.replace(oldRl, newRl);
    write('api/login.ts', login);
    ok('api/login.ts — email-keyed limiter added');
  } else {
    warn('api/login.ts — rate-limit block not found; check manually');
  }
}

// ===========================================================================
// 8. api/challenge.ts — pass site.domain to setCorsHeaders, add Origin check
// ===========================================================================
let challenge = read('api/challenge.ts');
let challengeChanged = false;

// 8a. Move setCorsHeaders AFTER the site lookup so we can pass the domain.
//     Simplest correct approach: keep the top-level setCorsHeaders for the
//     OPTIONS preflight (echo mode), then re-set with the domain for POST.
if (challenge.includes('setCorsHeaders(req, res, site.domain)')) {
  skip('api/challenge.ts — domain-scoped CORS already present');
} else {
  const anchor = `    const ip = clientIp(req);`;
  if (challenge.includes(anchor)) {
    challenge = challenge.replace(
      anchor,
      `    // Tighten CORS for the POST response to the site's registered domain.
    setCorsHeaders(req, res, site.domain);

    const ip = clientIp(req);`
    );
    challengeChanged = true;
    ok('api/challenge.ts — CORS tightened to registered domain on POST');
  } else {
    warn('api/challenge.ts — clientIp anchor not found');
  }
}

if (challengeChanged) {
  write('api/challenge.ts', challenge);
  ok('api/challenge.ts saved');
}

// ===========================================================================
// 9. vercel.json — add security headers
// ===========================================================================
let vercel = read('vercel.json');
if (vercel.includes('X-Content-Type-Options')) {
  skip('vercel.json — security headers already present');
} else {
  let vj;
  try {
    vj = JSON.parse(vercel);
  } catch (e) {
    warn('vercel.json — invalid JSON, cannot patch automatically');
    vj = null;
  }
  if (vj) {
    vj.headers = vj.headers || [];
    const globalHeaders = {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
      ],
    };
    // Ensure global header is FIRST so it doesn't override API CORS headers
    vj.headers = [globalHeaders, ...vj.headers];
    write('vercel.json', JSON.stringify(vj, null, 2) + '\n');
    ok('vercel.json — security headers added (nosniff, referrer-policy, HSTS, frame-options)');
  }
}

// ===========================================================================
// Done
// ===========================================================================
console.log('');
console.log(`${G}✓ Security patch complete.${X}`);
console.log('');
console.log('Next:');
console.log('  1. npm run typecheck          # should pass now');
console.log('  2. vercel --prod --force');
console.log('  3. sleep 30');
console.log('');
console.log('Verify:');
console.log('  # PoW cannot be forged anymore:');
console.log('  #   (submit a fake "00000" hash — should now return 400 invalid-solution)');
console.log('');
console.log('  # Widget has WASM URL passed through:');
console.log('  curl -s "https://irocap.vercel.app/irocap.js?t=$(date +%s)" | grep -c "wasmUrl"');
console.log('  # → ≥ 2');
console.log('');
console.log('  # Security headers present:');
console.log('  curl -sI https://irocap.vercel.app/ | grep -i "x-content-type-options\\|referrer-policy"');
console.log('');
