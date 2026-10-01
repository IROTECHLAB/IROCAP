/**
 * HMAC signing for challenges.
 *
 * The client must echo back issuedAt + sig. /api/verify validates the
 * signature before any DB hit, so tampered or fabricated challenges are
 * rejected cheaply.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getSecret(): string {
  const secret = process.env.IROCAP_CHALLENGE_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('IROCAP_CHALLENGE_SECRET is not configured or too short');
  }
  return secret;
}

function sign(challenge: string, difficulty: number, issuedAt: number): string {
  return createHmac('sha256', getSecret())
    .update(`${challenge}.${difficulty}.${issuedAt}`)
    .digest('hex');
}

export function signChallenge(
  challenge: string,
  difficulty: number,
): { issuedAt: number; sig: string } {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { issuedAt, sig: sign(challenge, difficulty, issuedAt) };
}

export interface ChallengeValidation {
  ok: boolean;
  reason?: 'bad-sig' | 'expired' | 'missing';
}

export function validateChallengeSignature(
  challenge: string,
  difficulty: number,
  issuedAt: number | undefined,
  sig: string | undefined,
): ChallengeValidation {
  if (
    typeof issuedAt !== 'number' ||
    typeof sig !== 'string' ||
    !challenge ||
    typeof difficulty !== 'number'
  ) {
    return { ok: false, reason: 'missing' };
  }

  // Age check first (cheap).
  const ageMs = Date.now() - issuedAt * 1000;
  if (ageMs < -5000 || ageMs > MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }

  let expected: string;
  try {
    expected = sign(challenge, difficulty, issuedAt);
  } catch {
    return { ok: false, reason: 'bad-sig' };
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-sig' };
  }

  return { ok: true };
}
