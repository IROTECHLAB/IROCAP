interface Ev {
  t: number;
  x?: number;
  y?: number;
  k?: string;
  s?: number;
}

export interface BehavioralResult {
  score: number;
  reasons: string[];
}

export function analyzeBehavior(
  events: Ev[] | undefined,
  durationMs: number,
): BehavioralResult {
  let score = 1.0;
  const reasons: string[] = [];

  if (!events || !Array.isArray(events)) return { score, reasons };
  if (events.length === 0) {
    if (durationMs > 2000) { score -= 0.3; reasons.push('no-events-slow-session'); }
    return { score, reasons };
  }

  let monotonic = true;
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.t < events[i - 1]!.t) { monotonic = false; break; }
  }
  if (!monotonic) { score -= 0.5; reasons.push('events-not-monotonic'); }

  const t0 = events[0]!.t;
  const tN = events[events.length - 1]!.t;
  if (events.length > 50 && tN - t0 < 100) { score -= 0.6; reasons.push('events-flooded-100ms'); }

  const moves = events.filter((e) => e.x !== undefined && e.y !== undefined);
  if (moves.length >= 20) {
    const vels: number[] = [];
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1]!, b = moves[i]!;
      const dt = Math.max(1, b.t - a.t);
      const dx = (b.x ?? 0) - (a.x ?? 0);
      const dy = (b.y ?? 0) - (a.y ?? 0);
      vels.push(Math.sqrt(dx * dx + dy * dy) / dt);
    }
    const mean = vels.reduce((s, v) => s + v, 0) / vels.length;
    const variance = vels.reduce((s, v) => s + (v - mean) ** 2, 0) / vels.length;
    if (variance < 0.005 && mean > 0) { score -= 0.5; reasons.push('zero-variance-mouse-velocity'); }

    let reversals = 0;
    for (let i = 2; i < moves.length; i++) {
      const a = moves[i - 2]!, b = moves[i - 1]!, c = moves[i]!;
      const v1x = (b.x ?? 0) - (a.x ?? 0), v1y = (b.y ?? 0) - (a.y ?? 0);
      const v2x = (c.x ?? 0) - (b.x ?? 0), v2y = (c.y ?? 0) - (b.y ?? 0);
      if (v1x * v2x + v1y * v2y < 0) reversals++;
    }
    if (moves.length > 50 && reversals === 0) { score -= 0.4; reasons.push('no-direction-changes'); }

    const uniq = new Set(moves.map((m) => `${m.x},${m.y}`));
    if (moves.length > 20 && uniq.size < 4) { score -= 0.4; reasons.push('static-coordinates'); }
  }

  const keys = events.filter((e) => e.k !== undefined);
  if (keys.length >= 8) {
    const gaps: number[] = [];
    for (let i = 1; i < keys.length; i++) gaps.push(keys[i]!.t - keys[i - 1]!.t);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    if (variance < 5 && gaps.length > 4) { score -= 0.5; reasons.push('robotic-keystroke-rhythm'); }
  }

  if (score < 0) score = 0;
  return { score, reasons };
}
