/**
 * Cross-check request headers and client-claimed signals for contradictions.
 * Inconsistencies are hard-to-fake evidence of automation — a real browser
 * keeps UA, client hints, and JS-observed values in sync automatically.
 */
import type { VercelRequest } from '@vercel/node';

export interface ConsistencyResult {
  score: number;      // 0..1
  reasons: string[];
}

export interface ClientClaims {
  language?: string;
  timezone?: string;
  screenSize?: string;
  colorDepth?: number;
}

function h(req: VercelRequest, name: string): string {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
}

export function checkConsistency(
  req: VercelRequest,
  claims: ClientClaims,
): ConsistencyResult {
  let score = 1.0;
  const reasons: string[] = [];

  const ua = h(req, 'user-agent');
  const acceptLang = h(req, 'accept-language');
  const secChUa = h(req, 'sec-ch-ua');
  const secChUaPlatform = h(req, 'sec-ch-ua-platform');
  const secChUaMobile = h(req, 'sec-ch-ua-mobile');
  const geoCountry = h(req, 'x-vercel-ip-country');

  const uaWindows = /Windows NT/.test(ua);
  const uaMac = /Macintosh|Mac OS X/.test(ua);
  const uaAndroid = /Android/.test(ua);
  const uaIos = /iPhone|iPad|iPod/.test(ua);
  const uaChrome = /Chrome\/\d+/.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);

  // 1. UA vs sec-ch-ua-platform
  if (uaWindows && secChUaPlatform === '"Android"') {
    score -= 0.5; reasons.push('ua-windows-ch-platform-android');
  }
  if (uaMac && secChUaPlatform === '"Windows"') {
    score -= 0.5; reasons.push('ua-mac-ch-platform-windows');
  }
  if (uaAndroid && secChUaPlatform === '"macOS"') {
    score -= 0.5; reasons.push('ua-android-ch-platform-mac');
  }

  // 2. Mobile flag consistency
  if ((uaAndroid || uaIos) && secChUaMobile === '?0') {
    score -= 0.4; reasons.push('mobile-ua-desktop-hint');
  }
  if (!uaAndroid && !uaIos && secChUaMobile === '?1') {
    score -= 0.4; reasons.push('desktop-ua-mobile-hint');
  }

  // 3. Chrome UA must have sec-ch-ua
  if (uaChrome && !secChUa) {
    score -= 0.5; reasons.push('chrome-no-sec-ch-ua');
  }

  // 4. Chrome version agreement between UA and sec-ch-ua
  const uaChromeVer = ua.match(/Chrome\/(\d+)/)?.[1];
  const chUaChromeVer = secChUa.match(/Chromium";v="(\d+)"/)?.[1];
  if (uaChromeVer && chUaChromeVer) {
    const delta = Math.abs(Number(uaChromeVer) - Number(chUaChromeVer));
    if (delta > 2) {
      score -= 0.4; reasons.push('chrome-version-mismatch');
    }
  }

  // 5. Language: accept-language primary vs JS navigator.language
  if (acceptLang && claims.language) {
    const primary = acceptLang.split(',')[0].split(';')[0].trim();
    const base = primary.split('-')[0].toLowerCase();
    const jsBase = claims.language.split('-')[0].toLowerCase();
    if (base && jsBase && base !== jsBase) {
      score -= 0.35; reasons.push('language-mismatch');
    }
  }

  // 6. Timezone vs Vercel geo country
  if (claims.timezone && geoCountry) {
    const region = claims.timezone.split('/')[0];
    const c = geoCountry.toUpperCase();
    const mismatch =
      (region === 'Europe' && ['US', 'CA', 'MX', 'BR', 'AR'].includes(c)) ||
      (region === 'America' && ['GB', 'DE', 'FR', 'IN', 'JP', 'CN', 'KR', 'RU'].includes(c)) ||
      (region === 'Asia' && ['US', 'CA', 'GB', 'DE', 'FR', 'BR'].includes(c)) ||
      (region === 'Australia' && ['US', 'GB', 'DE', 'FR', 'IN'].includes(c));
    if (mismatch) {
      score -= 0.3; reasons.push('timezone-geo-mismatch');
    }
  }

  // 7. Screen size sanity
  if (claims.screenSize) {
    const parts = claims.screenSize.split('x');
    const w = Number(parts[0]);
    const hh = Number(parts[1]);
    if (!w || !hh || w < 100 || hh < 100 || w > 10000 || hh > 10000) {
      score -= 0.4; reasons.push('impossible-screen');
    }
    if ((uaAndroid || uaIos) && w > 2500) {
      score -= 0.3; reasons.push('mobile-ua-huge-screen');
    }
  }

  // 8. Color depth sanity
  if (claims.colorDepth !== undefined) {
    if (claims.colorDepth !== 24 && claims.colorDepth !== 30 && claims.colorDepth !== 32) {
      score -= 0.2; reasons.push('unusual-color-depth');
    }
  }

  if (score < 0) score = 0;
  return { score, reasons };
}
