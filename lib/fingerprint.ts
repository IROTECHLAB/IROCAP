import { createHash } from 'node:crypto';
import type { IrocapSignals } from './scoring.js';

export function fingerprint(signals: IrocapSignals): string {
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
  return createHash('sha256').update(tuple).digest('hex').slice(0, 16);
}
