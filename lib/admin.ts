/**
 * Admin authentication primitives.
 *
 * - Passwords are hashed with scrypt (N=16384, r=8, p=1) using node:crypto.
 * - Admin session tokens are short-lived HS256 JWTs (12h) signed with a
 *   dedicated secret (IROCAP_ADMIN_JWT_SECRET) that is separate from the
 *   captcha token secret.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

export interface AdminSessionPayload {
  sub: number;
  email: string;
  role: 'admin';
}

export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return {
    hash: derived.toString('hex'),
    salt: salt.toString('hex'),
  };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  if (!password || !hash || !salt) return false;
  try {
    const saltBuf = Buffer.from(salt, 'hex');
    const expected = Buffer.from(hash, 'hex');
    const derived = await scrypt(password, saltBuf, SCRYPT_KEYLEN);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function getSessionSecret(): string {
  const secret = process.env.IROCAP_ADMIN_JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('IROCAP_ADMIN_JWT_SECRET is not configured or too short');
  }
  return secret;
}

export function signAdminSession(payload: AdminSessionPayload): string {
  return jwt.sign(payload, getSessionSecret(), {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function verifyAdminSession(token: string): AdminSessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSessionSecret(), {
      algorithms: ['HS256'],
    });
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).sub === 'number' &&
      typeof (decoded as Record<string, unknown>).email === 'string' &&
      (decoded as Record<string, unknown>).role === 'admin'
    ) {
      return {
        sub: (decoded as Record<string, unknown>).sub as number,
        email: (decoded as Record<string, unknown>).email as string,
        role: 'admin',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract and verify a Bearer admin token from an Authorization header. */
export function adminFromAuthHeader(
  authHeader: string | string[] | undefined,
): AdminSessionPayload | null {
  if (!authHeader) return null;
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw || typeof raw !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) return null;
  return verifyAdminSession(match[1]!.trim());
}

export const ADMIN_SESSION_TTL = SESSION_TTL_SECONDS;
