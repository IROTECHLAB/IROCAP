/**
 * Idempotent schema migration for irocap.
 * Run with: pnpm tsx scripts/migrate.ts
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✗ DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = neon(url);

  console.log('→ Running migrations…');

  await sql`
    CREATE TABLE IF NOT EXISTS sites (
      id           SERIAL PRIMARY KEY,
      sitekey      TEXT UNIQUE NOT NULL,
      secret       TEXT UNIQUE NOT NULL,
      domain       TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      active       BOOLEAN DEFAULT TRUE
    )
  `;
  console.log('  ✓ sites');

  await sql`
    CREATE UNLOGGED TABLE IF NOT EXISTS challenges (
      id           TEXT PRIMARY KEY,
      difficulty   INTEGER NOT NULL,
      sitekey      TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      solved       BOOLEAN DEFAULT FALSE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges (created_at)`;
  console.log('  ✓ challenges');

  await sql`
    CREATE UNLOGGED TABLE IF NOT EXISTS irocap_tokens (
      token        TEXT PRIMARY KEY,
      sitekey      TEXT NOT NULL,
      score        REAL NOT NULL,
      ip           INET,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      used         BOOLEAN DEFAULT FALSE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_tokens_created ON irocap_tokens (created_at)`;
  console.log('  ✓ irocap_tokens');

  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip           INET NOT NULL,
      sitekey      TEXT NOT NULL,
      count        INTEGER DEFAULT 0,
      window_start TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (ip, sitekey)
    )
  `;
  console.log('  ✓ rate_limits');

  // --- Admin users ---------------------------------------------------------
  await sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,   -- scrypt hash, hex
      password_salt TEXT NOT NULL,   -- scrypt salt, hex
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      active        BOOLEAN DEFAULT TRUE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email)`;
  console.log('  ✓ admin_users');

  console.log('✓ Migrations complete.');
}

main().catch((err: unknown) => {
  console.error('✗ Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
