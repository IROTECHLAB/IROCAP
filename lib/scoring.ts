/**
 * Risk scoring for irocap.
 *
 * Starts at 1.0 and decrements based on signals that correlate with bot or
 * automation behavior. Returns a score clamped to [0, 1]. Higher is better.
 */

export interface IrocapSignals {
  webdriver: boolean;
  touchSupport: boolean;
  mouseMovements: number;
  keyPresses: number;
  timeToInteract: number;
  canvasHash: string;
  webglVendor: string;
  screenSize: string;
  colorDepth: number;
  language: string;
  timezone: string;
  hardwareConcurrency: number;
  method: 'wasm' | 'js' | 'webcrypto';
  solveMs: number;
  pluginsCount?: number;
}

const CANVAS_BLOCKLIST = new Set<string>([
  // Known headless / virtualization canvas fingerprints.
  // Extend as you observe abuse. Empty by default.
  '0000000000000000',
]);

export function scoreSignals(signals: IrocapSignals): number {
  let score = 1.0;

  if (signals.webdriver) score -= 0.5;

  if (signals.mouseMovements === 0 && !signals.touchSupport) score -= 0.2;

  if (signals.timeToInteract < 500 && !signals.touchSupport) score -= 0.3;

  const pluginsCount = signals.pluginsCount ?? -1;
  if (pluginsCount === 0 && !signals.touchSupport) score -= 0.1;

  if (CANVAS_BLOCKLIST.has(signals.canvasHash)) score = 0;

  if (signals.method === 'wasm' && signals.solveMs > 30000) score -= 0.4;
  if (signals.method === 'webcrypto' && signals.solveMs < 10) score -= 0.4;

  if (signals.solveMs < 5) score -= 0.3;

  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}

export function difficultyForSignals(base: number, score: number): number {
  if (score < 0.3) return Math.min(base + 2, 8);
  if (score < 0.6) return Math.min(base + 1, 8);
  return base;
}
