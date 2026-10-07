import { createHmac } from 'node:crypto';
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
}