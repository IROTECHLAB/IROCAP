/**
 * JWT sign/verify helpers for irocap tokens.
 *
 * Tokens are HS256, 5-minute expiry, single-use (enforced in the DB).
 * The payload deliberately includes the score so siteverify can return it
 * without a second DB round-trip.
 */
import jwt from 'jsonwebtoken';

export interface IrocapTokenPayload {
  sitekey: string;
  score: number;
  challenge: string;
}

const TOKEN_TTL_SECONDS = 300; // 5 minutes

function getSecret(): string {
  const secret = process.env.IROCAP_JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('IROCAP_JWT_SECRET is not configured or too short');
  }
  return secret;
}

export function signToken(payload: IrocapTokenPayload): string {
  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

export function verifyToken(token: string): IrocapTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).sitekey === 'string' &&
      typeof (decoded as Record<string, unknown>).score === 'number' &&
      typeof (decoded as Record<string, unknown>).challenge === 'string'
    ) {
      return {
        sitekey: (decoded as Record<string, unknown>).sitekey as string,
        score: (decoded as Record<string, unknown>).score as number,
        challenge: (decoded as Record<string, unknown>).challenge as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const TOKEN_TTL = TOKEN_TTL_SECONDS;
