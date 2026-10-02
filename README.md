# irocap

A privacy-first Proof-of-Work CAPTCHA.

- No image puzzles.
- No user interaction.
- No cookies, no third-party scripts, no tracking.
- Runs on Vercel serverless functions + NeonDB (both free-tier friendly).

Visitors silently solve a SHA-256 hash puzzle in a Web Worker. Suspicious
traffic is scored and challenged harder.

---

## Table of contents

1. How it works
2. Features
3. Quick start
4. Deploy to Vercel
5. Admin panel
6. Integration
7. Configuration reference
8. Architecture
9. Anti-automation layers
10. Performance
11. Security notes
12. Limitations
13. License

---

## How it works

1. The widget asks <code>POST /api/challenge</code> for a random 48-character
   hex challenge plus a difficulty (default 5 = 5 leading zero hex chars).

2. A Web Worker builds itself from an inline Blob URL and solves the puzzle:
   it brute-forces a nonce until <code>SHA256(challenge + nonce)</code>
   starts with N zeros.

3. The widget collects behavioral and browser signals and posts everything to
   <code>/api/verify</code>. The server re-checks the hash, marks the
   challenge solved atomically (replay protection), computes a risk score,
   and signs a 5-minute HS256 JWT.

4. The widget injects
   <code>&lt;input type="hidden" name="irocap-token"&gt;</code> into the
   nearest form and fires <code>callback(token, score)</code>.

5. Your backend calls <code>POST /api/siteverify</code> with your secret and
   the token. Single-use is enforced by an atomic
   <code>UPDATE ... WHERE used=FALSE RETURNING</code>.

---

## Features

- Three-tier solver — Web Worker + WASM, Web Worker + inline JS, then
  <code>crypto.subtle</code> on the main thread. Same hash, three paths.
- HMAC-signed challenges — prevents forged or tampered challenges without a
  DB lookup.
- Server-observed trusted signals — UA, Accept-Language,
  <code>sec-ch-ua</code>, <code>sec-fetch-*</code>, Origin, Referer, timing,
  ASN. Read from the HTTP request itself, not from the client's body.
- Consistency checks — cross-checks headers against client-claimed values.
- Behavioral telemetry — mouse paths, keystroke rhythm, scroll events.
- Fingerprint reputation — hash-based identity with per-fingerprint trust.
- IP reputation — per-IP trust scoring across many solves.
- ASN blocking — cloud datacenter IPs capped at score 0.15.
- Single-use tokens — atomic DB enforcement.
- Rate limiting — 60 challenges per minute per IP per sitekey.
- Automatic cleanup — opportunistic + Vercel daily cron + optional external.
- Admin panel — email/password login, site registration, secret rotation,
  live stats. Mobile-friendly.
- No build step — the widget is one file.

---

## Quick start

### 1. Clone the repository

<pre><code>git clone https://github.com/IROTECHLAB/irocap.git
cd irocap</code></pre>

### 2. Set up the database

Open https://console.neon.tech, create a project, and copy the **pooled**
connection string (hostname contains <code>-pooler</code>).

If it ends with <code>&amp;channel_binding=require</code>, remove that
parameter before using it.

Open the Neon SQL Editor and paste the contents of
<code>scripts/schema.sql</code>. Click Run. Verify all 8 tables were created:

<pre><code>SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;</code></pre>

Expected: <code>admin_users</code>, <code>challenges</code>,
<code>fingerprints</code>, <code>ip_asn</code>, <code>ip_reputation</code>,
<code>irocap_tokens</code>, <code>rate_limits</code>, <code>sites</code>.

### 3. Configure environment

Copy <code>.env.example</code> to <code>.env</code> and fill in the values.
See the Configuration reference section for what each variable does.

Generate secrets with:

<pre><code>node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"</code></pre>

### 4. Create the first admin user

Generate a password hash:

<pre><code>node -e "
  const { randomBytes, scryptSync } = require('node:crypto');
  const pw = process.argv[1];
  const salt = randomBytes(16);
  console.log('hash:', scryptSync(pw, salt, 64).toString('hex'));
  console.log('salt:', salt.toString('hex'));
" 'your-password'</code></pre>

In the Neon SQL Editor:

<pre><code>INSERT INTO admin_users (email, password_hash, password_salt, active)
VALUES (
  'you@example.com',
  '&lt;hash from above&gt;',
  '&lt;salt from above&gt;',
  TRUE
);</code></pre>

### 5. Deploy

<pre><code>vercel --prod</code></pre>

Or run the dev server if you have the Vercel CLI installed locally:

<pre><code>vercel dev</code></pre>

Open <code>/admin.html</code> to register your first site.

---

## Deploy to Vercel

### 1. Prepare Neon

1. Sign up at https://console.neon.tech
2. Create a project
3. Copy the pooled connection string
4. Run <code>scripts/schema.sql</code> in the SQL Editor

### 2. Prepare Vercel

1. Sign up at https://vercel.com
2. Install the CLI: <code>npm i -g vercel</code>
3. Link the project: <code>vercel link</code>

### 3. Push environment variables

<pre><code>vercel env add DATABASE_URL production
vercel env add IROCAP_JWT_SECRET production
vercel env add IROCAP_ADMIN_JWT_SECRET production
vercel env add IROCAP_CHALLENGE_SECRET production
vercel env add CRON_SECRET production</code></pre>

Optionally add <code>IPINFO_TOKEN</code> for ASN blocking (free tier of
ipinfo.io covers 50,000 lookups/month).

### 4. Deploy

<pre><code>vercel --prod</code></pre>

### 5. Create admin + register site

Insert the admin user via SQL (see Quick start step 4), then open
<code>/admin.html</code> and register a site.

### 6. Optional — external cleanup cron

Cleanup runs opportunistically inside <code>/api/challenge</code> and
<code>/api/verify</code> on about 2% of requests. The Vercel daily cron runs
at 03:00 UTC. For more frequent purging, add an external scheduler:

- cron-job.org — URL <code>https://your-deployment.vercel.app/api/cleanup</code>,
  method GET, header <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code>,
  every 10 minutes.
- UptimeRobot — HTTP monitor on the same URL with the same header.

---

## Admin panel

Access at <code>/admin.html</code>.

| Feature | Description |
| --- | --- |
| Sign in | Email + password, scrypt-hashed, 12-hour session JWT |
| Overview | Counters: active sites, 24h challenges, tokens, consumed |
| Register a site | Create a new sitekey + secret pair for a domain |
| Site cards | Sitekey, masked secret, created date, active state |
| Regenerate secret | Rotate the secret; the old one stops working immediately |
| Activate / Deactivate | Toggle whether the site accepts challenges |
| Delete | Remove the site and invalidate its keys |

The secret is write-only. To retrieve a new one, use **Regenerate secret** —
it invalidates the old one and shows the new one exactly once.

---

## Integration

### 1. Add the widget

<pre><code>&lt;script src="https://your-deployment.vercel.app/irocap.js"&gt;&lt;/script&gt;

&lt;form action="/submit" method="POST"&gt;
  &lt;input type="email" name="email" required /&gt;
  &lt;div class="irocap"&gt;&lt;/div&gt;
  &lt;button type="submit"&gt;Submit&lt;/button&gt;
&lt;/form&gt;

&lt;script&gt;
  new Irocap('YOUR_SITEKEY', {
    container: '.irocap'
  });
&lt;/script&gt;</code></pre>

The widget inserts a hidden <code>irocap-token</code> field into the form.

### 2. Verify on your server

<pre><code>const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    secret: process.env.IROCAP_SECRET,
    response: req.body['irocap-token'],
    remoteip: req.ip
  })
});
const result = await r.json();

if (!result.success || result.score &lt; 0.5) {
  return res.status(400).send('CAPTCHA failed');
}</code></pre>

See <code>INTEGRATION.md</code> for framework-specific examples (Express,
Next.js, Fastify, Cloudflare Workers, PHP, Python, Go, Ruby, WordPress).

---

## Configuration reference

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| <code>DATABASE_URL</code> | Yes | Neon pooled Postgres URL |
| <code>IROCAP_JWT_SECRET</code> | Yes | Signing key for post-solve tokens (5 min TTL) |
| <code>IROCAP_ADMIN_JWT_SECRET</code> | Yes | Signing key for admin sessions (12 h TTL) |
| <code>IROCAP_CHALLENGE_SECRET</code> | Yes | HMAC key for signing challenges |
| <code>CRON_SECRET</code> | Yes | Bearer token protecting <code>/api/cleanup</code> |
| <code>IPINFO_TOKEN</code> | No | Enables ASN lookup for datacenter blocking |
| <code>IROCAP_BASE_URL</code> | No | Public base URL used by scripts |
| <code>IROCAP_ADMIN_EMAIL</code> | No | Convenience for CLI scripts |
| <code>IROCAP_ADMIN_PASSWORD</code> | No | Convenience for CLI scripts |

### Widget options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| <code>sitekey</code> | string | Yes | Public sitekey from the admin panel |
| <code>container</code> | string or Element | Yes | Where the badge renders |
| <code>callback</code> | function | No | <code>(token, score) =&gt; void</code> |
| <code>error-callback</code> | function | No | <code>(err) =&gt; void</code> |
| <code>base</code> | string | No | Override the irocap base URL |

### Score thresholds

| Range | Meaning | Suggested action |
| --- | --- | --- |
| 0.8 – 1.0 | Very likely human | Accept |
| 0.5 – 0.8 | Probably human | Accept |
| 0.3 – 0.5 | Mildly suspicious | Accept with rate limit |
| 0.0 – 0.3 | Likely bot | Reject |

Recommended default: <code>score &gt;= 0.5</code>.

---

## Architecture

<pre><code>irocap/
├── api/                     Vercel serverless functions
│   ├── challenge.ts         Issue signed challenge
│   ├── verify.ts            Verify PoW + score signals + issue JWT
│   ├── siteverify.ts        Site-owner verification endpoint
│   ├── cleanup.ts           Cron-protected purge
│   ├── register.ts          Admin: create a site
│   ├── login.ts             Admin login
│   ├── logout.ts            Admin logout
│   ├── sites.ts             Admin: list sites
│   ├── stats.ts             Admin: dashboard counters
│   └── site-manage.ts       Admin: rotate/toggle/delete
├── lib/
│   ├── db.ts                Neon HTTP client
│   ├── tokens.ts            JWT sign/verify
│   ├── admin.ts             scrypt password + admin session JWT
│   ├── scoring.ts           Risk scoring
│   ├── rate-limit.ts        IP+sitekey throttle
│   ├── cleanup.ts           Opportunistic purge
│   ├── challenge-sign.ts    HMAC for challenges
│   ├── trusted.ts           Server-observed signals
│   ├── consistency.ts       Header/client cross-checks
│   ├── behavioral.ts        Event-stream analysis
│   ├── fingerprint.ts       Fingerprint hashing
│   ├── asn.ts               ASN lookup + datacenter blocklist
│   └── cors.ts              CORS preflight helpers
├── public/
│   ├── irocap.js            Single-file widget
│   ├── index.html           Demo page
│   ├── admin.html           Admin dashboard
│   └── wasm/
│       └── sha256.umd.min.js  Self-hosted hash-wasm UMD
├── scripts/
│   ├── schema.sql           Complete database schema
│   ├── create-admin.ts      Password hash generator
│   ├── register-site.ts     Register a site
│   └── e2e.ts               End-to-end test
├── vercel.json
└── package.json</code></pre>

### Database schema

| Table | Purpose |
| --- | --- |
| <code>sites</code> | Registered domains with sitekey + secret |
| <code>challenges</code> | Issued challenges (UNLOGGED, ephemeral) |
| <code>irocap_tokens</code> | Issued JWTs with single-use flag |
| <code>rate_limits</code> | Sliding-window counters per IP + sitekey |
| <code>admin_users</code> | Admin accounts (scrypt hash) |
| <code>fingerprints</code> | Per-fingerprint reputation |
| <code>ip_reputation</code> | Per-IP trust scores |
| <code>ip_asn</code> | Cached ASN lookups |

---

## Anti-automation layers

Each layer is independent. Removing one doesn't break the others.

1. Signed challenges (HMAC) — forged or tampered challenges are rejected
   without a DB hit.
2. Server-observed trusted signals — UA, headers, origin, referer, timing,
   ASN, all read from the HTTP request.
3. Consistency checks — cross-verifies headers vs client claims.
4. Behavioral telemetry — event stream analysis for scripted motion.
5. Fingerprint reputation — persistent trust per browser fingerprint.
6. IP reputation — persistent trust per IP.
7. ASN blocking — cloud infrastructure is capped at score 0.15.
8. Atomic single-use — replay attacks impossible.
9. Rate limiting — 60 challenges/min per IP+sitekey.
10. Adaptive difficulty — difficulty rises for suspicious IPs and bursts.

---

## Performance

We do not claim irocap is faster or slower than any other CAPTCHA. Solve
time depends on the visitor's device, browser, and network. You should
benchmark on your own traffic before making any decisions about UX.

**What we can describe accurately:**

- The primary solver is a Web Worker. It does not block the main thread
  regardless of how long the solve takes.
- The challenge has no timer from the user's perspective. Users see a
  "Verifying…" badge and can continue filling the form.
- A three-tier fallback chain (WASM → inline JS → <code>crypto.subtle</code>)
  ensures the solve completes on all modern browsers, at the cost of speed
  on older devices.
- Total added latency to a form submission depends on:
  - The visitor's CPU (hash rate)
  - The challenge difficulty (default 5, meaning ~1 million average
    hash attempts)
  - Whether WASM loaded successfully

**What we have observed in informal testing (not a benchmark):**

- On modern desktop browsers, solves typically complete in well under a
  second.
- On mid-range Android devices, solves can take several seconds.
- On budget or older Android devices, solves can take longer.

**We make no promise about speed.** If your audience is on constrained
devices and speed matters, you can lower the base difficulty in
<code>api/challenge.ts</code> (this reduces security proportionally).

If a solve takes too long and the widget hits its internal timeout, it
falls back to the next solver tier rather than failing.

---

## Security notes

- **Never expose the secret.** Server-side environment variables only.
  Rotate immediately if leaked.
- **Verify on the server.** The widget's callback is a hint. Always call
  <code>/api/siteverify</code> from your backend.
- **Enforce a score threshold.** A <code>success: true</code> with a low
  score still means a likely bot. Check both.
- **Single-use.** Do not retry verification on failure. A retry burns the
  token.
- **Rate limit your own endpoints.** irocap handles CAPTCHA rate limiting;
  your signup/login endpoints still need their own.
- **Log suspicious activity.** A burst of <code>already-used</code> errors
  from one IP is a replay signal.
- **Never put the secret in client-side code.**

---

## Limitations

Honest list of what irocap does **not** stop:

- Real-browser AI agents (Manus, Operator, Claude computer-use). These are
  indistinguishable from real users by design.
- Stealth-patched Puppeteer or Playwright on residential IPs.
- TLS-impersonating proxies (JA3/JA4 spoofing). Vercel abstracts the TLS
  layer, so we can't inspect the handshake.
- Targeted, patient attackers who mimic human behavior slowly.

This is the same fundamental ceiling every client-side CAPTCHA has.

**What irocap does stop:**

- Plain HTTP clients (curl, requests, axios, Go http, etc.)
- Selenium / Puppeteer with default settings
- Headless Chrome without stealth patches
- Selenium with UA spoofing but no <code>sec-ch-ua</code>
- Datacenter-hosted bots
- Naive mouse/keyboard scripting
- Replay attacks and cross-site token reuse
- Brute-force flooding

For many sites, that covers the practical threat model.

---

## License

[MIT](LICENSE)
