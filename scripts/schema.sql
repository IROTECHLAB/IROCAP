-- ============================================================================
-- irocap — complete database schema
-- Idempotent. Safe to run multiple times.
-- ============================================================================
--
-- Tables:
--   sites            — registered site owners (sitekey + secret)
--   challenges       — issued PoW challenges (ephemeral)
--   irocap_tokens    — issued single-use JWTs
--   rate_limits      — sliding-window counters per IP + sitekey
--   admin_users      — admin accounts (scrypt password hash)
--   fingerprints     — per-fingerprint reputation
--   ip_reputation    — per-IP trust scores
--   ip_asn           — cached ASN lookups for datacenter detection
--
-- Run this file against a fresh Neon database to bootstrap irocap.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- sites — registered site owners
-- ---------------------------------------------------------------------------
-- Each row is a domain that has been given a sitekey + secret pair.
-- The sitekey is public (embedded in HTML). The secret is server-only and
-- must never be exposed to the browser.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id           SERIAL PRIMARY KEY,
  sitekey      TEXT UNIQUE NOT NULL,
  secret       TEXT UNIQUE NOT NULL,
  domain       TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  active       BOOLEAN DEFAULT TRUE
);


-- ---------------------------------------------------------------------------
-- challenges — issued PoW challenges
-- ---------------------------------------------------------------------------
-- Every call to /api/challenge inserts one row. Rows are marked solved=TRUE
-- atomically on the first verification attempt (success or failure), which
-- prevents replay. Cleanup deletes rows older than 10 minutes.
--
-- UNLOGGED means no WAL — much faster writes, data does not survive a crash,
-- which is fine since challenges are ephemeral.
-- ---------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS challenges (
  id           TEXT PRIMARY KEY,
  difficulty   INTEGER NOT NULL,
  sitekey      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  solved       BOOLEAN DEFAULT FALSE,
  issued_at    BIGINT,
  signature    TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenges_created ON challenges (created_at);


-- ---------------------------------------------------------------------------
-- irocap_tokens — issued single-use JWTs
-- ---------------------------------------------------------------------------
-- One row per successful /api/verify. The `used` flag is flipped to TRUE by
-- /api/siteverify via an atomic UPDATE ... WHERE used=FALSE RETURNING, which
-- enforces single-use.
--
-- Cleanup deletes rows older than 1 hour.
-- UNLOGGED for the same reason as challenges.
-- ---------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS irocap_tokens (
  token        TEXT PRIMARY KEY,
  sitekey      TEXT NOT NULL,
  score        REAL NOT NULL,
  ip           INET,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  used         BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON irocap_tokens (created_at);


-- ---------------------------------------------------------------------------
-- rate_limits — sliding-window counters
-- ---------------------------------------------------------------------------
-- One row per (IP, sitekey) pair. The count increments on each request; when
-- the 60-second window expires, the counter resets.
--
-- Cleanup deletes rows whose window_start is older than 5 minutes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  ip           INET NOT NULL,
  sitekey      TEXT NOT NULL,
  count        INTEGER DEFAULT 0,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ip, sitekey)
);


-- ---------------------------------------------------------------------------
-- admin_users — admin accounts
-- ---------------------------------------------------------------------------
-- Password is scrypt-hashed with a random 16-byte salt. Both hash and salt
-- are stored as hex strings. Sessions are signed JWTs (12h TTL), not stored
-- in the database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  active        BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (email);


-- ---------------------------------------------------------------------------
-- fingerprints — per-fingerprint reputation
-- ---------------------------------------------------------------------------
-- The widget hashes (canvasHash, webglVendor, screenSize, colorDepth,
-- language, timezone, hardwareConcurrency, pluginsCount) into a 16-char hex
-- fingerprint. Each verify updates the counters and recomputes reputation as
-- good_hits / total_hits.
--
-- A fingerprint with many bad_hits and few good_hits gets capped at its
-- reputation value on future solves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fingerprints (
  fp           TEXT PRIMARY KEY,
  first_seen   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  total_hits   INTEGER DEFAULT 0,
  good_hits    INTEGER DEFAULT 0,
  bad_hits     INTEGER DEFAULT 0,
  reputation   REAL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_fp_last_seen ON fingerprints (last_seen);


-- ---------------------------------------------------------------------------
-- ip_reputation — per-IP trust scores
-- ---------------------------------------------------------------------------
-- Same idea as fingerprints, but keyed on IP. A trusted IP sees lower
-- difficulty challenges; a suspicious one sees higher.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_reputation (
  ip           INET PRIMARY KEY,
  first_seen   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  total_solves INTEGER DEFAULT 0,
  good_solves  INTEGER DEFAULT 0,
  bad_solves   INTEGER DEFAULT 0,
  reputation   REAL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_ip_rep_last_seen ON ip_reputation (last_seen);


-- ---------------------------------------------------------------------------
-- ip_asn — cached ASN lookups
-- ---------------------------------------------------------------------------
-- Populated on-demand by /api/verify when IPINFO_TOKEN is configured.
-- Cache entries expire after 7 days. Only the fields we need for datacenter
-- detection are stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_asn (
  ip         INET PRIMARY KEY,
  asn        INTEGER,
  org        TEXT,
  country    TEXT,
  cached_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ip_asn_cached ON ip_asn (cached_at);


-- ============================================================================
-- Optional but recommended: retention indexes for cleanup
-- ============================================================================
-- These indexes speed up the DELETE queries run by /api/cleanup. If you
-- already have the indexes above, these are redundant, but they don't hurt.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_challenges_created_desc
  ON challenges (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tokens_created_desc
  ON irocap_tokens (created_at DESC);


-- ============================================================================
-- Notes on cleanup
-- ============================================================================
-- Cleanup is triggered from three sources:
--
--   1. Opportunistic — ~2% of /api/challenge and /api/verify requests call
--      runCleanup() fire-and-forget. This keeps the tables small even if
--      no cron is configured.
--
--   2. Vercel daily cron — configured in vercel.json as:
--        { "path": "/api/cleanup", "schedule": "0 3 * * *" }
--      Vercel auto-sends Authorization: Bearer $CRON_SECRET.
--
--   3. External scheduler — cron-job.org, UptimeRobot, GitHub Actions, etc.
--      hit /api/cleanup with:
--        Authorization: Bearer $CRON_SECRET
--
-- Retention windows enforced by cleanup:
--   challenges      →  deleted after 10 minutes
--   irocap_tokens   →  deleted after 1 hour
--   rate_limits     →  deleted when window_start > 5 minutes old
--   fingerprints    →  NOT deleted (reputation accumulates)
--   ip_reputation   →  NOT deleted
--   ip_asn          →  NOT deleted (entries expire via cached_at check)
--   admin_users     →  NOT deleted
--   sites           →  NOT deleted (use the admin panel to remove)
-- ============================================================================