/**
 * Server-observed "trusted" signals.
 *
 * These are read from the HTTP request itself — not from the client's JSON
 * body. An attacker with a raw HTTP client (curl, requests, axios) cannot
 * fake the presence or absence of these headers consistently.
 *
 * The score from this module is the PRIMARY risk signal; client-claimed
 * behavioral signals are used only as a tie-breaker.
 */
import type { VercelRequest } from '@vercel/node';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const HEADLESS_UA_PATTERNS: RegExp[] = [
  /headlesschrome/i,
  /phantomjs/i,
  /puppeteer/i,
  /playwright/i,
  /slimerjs/i,
  /casperjs/i,
  /\bjsdom\b/i,
  /\bhtmlunit\b/i,
];

const BOT_UA_PATTERNS: RegExp[] = [
  /^curl\//i,
  /^wget\//i,
  /^python-requests\//i,
  /^python-urllib\//i,
  /^python-httpx\//i,
  /^aiohttp\//i,
  /^go-http-client\//i,
  /^okhttp\//i,
  /^axios\//i,
  /^node-fetch\//i,
  /^undici\//i,
  /^java\//i,
  /^libwww-perl\//i,
  /^httpclient\//i,
  /^scrapy\//i,
  /^postmanruntime\//i,
  /^insomnia\//i,
  /^httpie\//i,
  /^guzzle\//i,
  /^dart\//i,
  /^nike\b/i,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustedSignals {
  userAgent: string;
  isHeadlessUa: boolean;
  isBotUa: boolean;
  hasAcceptLanguage: boolean;
  hasAcceptEncoding: boolean;
  hasSecChUa: boolean;
  claimsChrome: boolean;
  claimsFirefox: boolean;
  claimsSafari: boolean;
  hasSecFetchSite: boolean;
  hasSecFetchMode: boolean;
  hasSecFetchDest: boolean;
  hasOrigin: boolean;
  originMatches: boolean;
  refererMatches: boolean;
  elapsedMs: number;
}

export interface TrustedVerdict {
  score: number; // 0..1
  botDetected: boolean; // hard reject
  signals: TrustedSignals;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function header(req: VercelRequest, name: string): string {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
}

function hostMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const target = domain
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
    return host === target || host.endsWith('.' + target);
  } catch {
    return false;
  }
}

export function extractTrustedSignals(
  req: VercelRequest,
  expectedDomain: string,
  challengeIssuedAt: Date | string,
): TrustedSignals {
  const ua = header(req, 'user-agent');
  const origin = header(req, 'origin');
  const referer = header(req, 'referer');

  const issued = typeof challengeIssuedAt === 'string'
    ? new Date(challengeIssuedAt)
    : challengeIssuedAt;

  const claimsChrome = /\bChrome\/\d+/.test(ua) && !/\bEdg\//.test(ua) && !/\bOPR\//.test(ua);
  const claimsFirefox = /\bFirefox\/\d+/.test(ua);
  const claimsSafari = /\bSafari\/\d+/.test(ua) && !/\bChrome\//.test(ua) && !/\bChromium\//.test(ua);

  return {
    userAgent: ua,
    isHeadlessUa: HEADLESS_UA_PATTERNS.some((p) => p.test(ua)),
    isBotUa: BOT_UA_PATTERNS.some((p) => p.test(ua)),
    hasAcceptLanguage: !!header(req, 'accept-language'),
    hasAcceptEncoding: !!header(req, 'accept-encoding'),
    hasSecChUa: !!header(req, 'sec-ch-ua'),
    claimsChrome,
    claimsFirefox,
    claimsSafari,
    hasSecFetchSite: !!header(req, 'sec-fetch-site'),
    hasSecFetchMode: !!header(req, 'sec-fetch-mode'),
    hasSecFetchDest: !!header(req, 'sec-fetch-dest'),
    hasOrigin: !!origin,
    originMatches: origin ? hostMatches(origin, expectedDomain) : false,
    refererMatches: referer ? hostMatches(referer, expectedDomain) : false,
    elapsedMs: Date.now() - issued.getTime(),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreTrustedSignals(s: TrustedSignals): TrustedVerdict {
  let score = 1.0;
  const reasons: string[] = [];
  let botDetected = false;

  // --- Hard rejects ---------------------------------------------------------
  if (s.isBotUa) {
    botDetected = true;
    score = 0;
    reasons.push('raw-http-client-ua');
  }
  if (s.isHeadlessUa) {
    botDetected = true;
    score = 0;
    reasons.push('headless-ua');
  }

  // --- Soft penalties -------------------------------------------------------
  if (!s.hasAcceptLanguage) {
    score -= 0.4;
    reasons.push('no-accept-language');
  }

  if (s.claimsChrome && !s.hasSecChUa) {
    score -= 0.5;
    reasons.push('chrome-ua-without-sec-ch-ua');
  }

  if (s.claimsChrome && !s.hasSecFetchSite) {
    score -= 0.4;
    reasons.push('chrome-ua-without-sec-fetch-site');
  }

  if (s.claimsChrome && !s.hasSecFetchMode) {
    score -= 0.4;
    reasons.push('chrome-ua-without-sec-fetch-mode');
  }

  if (!s.hasAcceptEncoding) {
    score -= 0.2;
    reasons.push('no-accept-encoding');
  }

  // No Origin AND no Referer → almost certainly not a browser.
  if (!s.hasOrigin && !s.refererMatches) {
    score -= 0.6;
    reasons.push('no-origin-no-referer');
  }

  // Origin present but for the wrong host → suspicious.
  if (s.hasOrigin && !s.originMatches) {
    score -= 0.4;
    reasons.push('origin-mismatch');
  }

  // Faster than any real browser round-trip.
  if (s.elapsedMs < 100) {
    score -= 0.5;
    reasons.push('too-fast-100ms');
  }
  if (s.elapsedMs < 20) {
    score = 0;
    reasons.push('too-fast-20ms');
  }

  // Sanity: solver claimed a match but the request didn't take long enough
  // to even generate a challenge and hash once.
  if (s.elapsedMs < 5) {
    score = 0;
    reasons.push('physically-impossible');
  }

  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { score, botDetected, signals: s, reasons };
}
