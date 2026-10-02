# Contributing to irocap

Thanks for considering a contribution. This is a small project with a focused scope — please read this file before opening a pull request.

---

## What we want

- Bug fixes with clear reproduction steps
- Security improvements with a stated threat model
- New anti-automation layers that are implementable in a single deployment (no global infrastructure required)
- Better mobile compatibility, especially for budget Android devices
- Documentation improvements

## What we don't want

- Dependencies on Redis, Cloudflare, Upstash, or any service that requires a paid tier for basic functionality
- Third-party CDNs loaded at runtime by the widget
- Frameworks (React/Vue/Next.js) as hard dependencies for the widget itself
- Features that require server-side state outside NeonDB
- Detection heuristics that rely on mass-scale data (we don't have it, and can't get it)

---

## Development setup

### Prerequisites

- Node.js 20+
- A Neon account (free tier is fine)
- A Vercel account (free tier is fine)

### Local setup

<pre><code>git clone https://github.com/your-username/irocap.git
cd irocap
npm install
cp .env.example .env</code></pre>

Fill in <code>.env</code> with real values. See <code>README.md</code> for what each variable does.

Run migrations:

Open https://console.neon.tech → SQL Editor and paste the contents of <code>scripts/schema.sql</code>. Click Run. The schema is idempotent — safe to run multiple times.

Create an admin user:

<pre><code>IROCAP_ADMIN_EMAIL=dev@localhost \
IROCAP_ADMIN_PASSWORD='dev-password' \
npm run create-admin</code></pre>

Start the dev server:

<pre><code>npm run dev</code></pre>

Open <code>http://localhost:3000/admin.html</code> to register a test site.

---

## Project layout

<pre><code>api/          Vercel serverless functions (Node runtime)
lib/          Shared server-side code
public/       Static assets + widget + admin panel
scripts/      CLI utilities
vercel.json   Deployment config
</code></pre>

### Where things live

| Area | File(s) | Notes |
| --- | --- | --- |
| Challenge signing | <code>lib/challenge-sign.ts</code> | HMAC for challenges |
| Server-observed signals | <code>lib/trusted.ts</code> | Reads request headers |
| Header cross-checks | <code>lib/consistency.ts</code> | UA vs sec-ch-ua vs claims |
| Behavioral analysis | <code>lib/behavioral.ts</code> | Event-stream pattern detection |
| Fingerprint hashing | <code>lib/fingerprint.ts</code> | canvas + webgl + screen hash |
| ASN lookup | <code>lib/asn.ts</code> | ipinfo.io + datacenter blocklist |
| Scoring | <code>lib/scoring.ts</code> | Client-claimed signals only |
| Rate limiting | <code>lib/rate-limit.ts</code> | Sliding window in DB |
| Widget | <code>public/irocap.js</code> | Single file, no build step |
| Admin UI | <code>public/admin.html</code> | Vanilla JS, no framework |

---

## Coding conventions

- TypeScript strict mode. No <code>any</code> in public API surfaces.
- <code>node:</code> prefix on all built-in imports (<code>node:crypto</code>, <code>node:util</code>).
- No <code>console.log</code> in production code. Use <code>console.warn</code> / <code>console.error</code> for real issues only.
- Comments explain "why," not "what."
- No external runtime dependencies for the widget.

### Error handling

Every API handler must:

1. Set <code>Cache-Control: no-store</code> and <code>Content-Type: application/json</code>.
2. Answer CORS preflight via <code>setCorsHeaders</code> + <code>handlePreflight</code>.
3. Return structured JSON for errors: <code>{ "error": "..." }</code>.
4. Never expose stack traces to the client.
5. Log the full error server-side with <code>console.error</code>.

### Add a new anti-automation layer

1. Create <code>lib/your-layer.ts</code> exporting a scoring function that returns <code>{ score: number, reasons: string[] }</code>.
2. Import it in <code>api/verify.ts</code>.
3. Compute its score alongside the existing signals.
4. Combine with <code>Math.min(...)</code> so any single weak signal caps the total.
5. Log fired reasons via <code>console.warn('[irocap] your-layer flags', { ... })</code>.

---

## Testing

### Type check

<pre><code>npm run typecheck</code></pre>

### End-to-end test

With a running deployment:

<pre><code>IROCAP_BASE_URL=http://localhost:3000 \
IROCAP_ADMIN_EMAIL=dev@localhost \
IROCAP_ADMIN_PASSWORD='dev-password' \
npm run e2e</code></pre>

### Manual widget test

Open <code>http://localhost:3000/</code>. The badge should go from **Verifying…** to **Verified** in under 3 seconds on a normal device.

### Cross-device testing

We especially care about:

- Budget Android (Redmi, Realme, older Samsung A-series)
- Low-end iOS (iPhone SE 1st gen, old iPads)
- Desktop Chrome / Firefox / Safari

If your change affects the widget, please test on at least one mobile device.

---

## Commit style

Short imperative subject, blank line, optional body.

Good:

<pre><code>fix: guard e.key against IME composition events

Android soft keyboards emit keydown with e.key === undefined.
The previous code called e.key.length and threw.</code></pre>

Bad:

<pre><code>fixed stuff</code></pre>

---

## Pull request checklist

Before opening a PR:

- [ ] <code>npm run typecheck</code> passes
- [ ] No new dependencies added to the widget
- [ ] No breaking changes to the widget's public API without a major version bump
- [ ] README.md updated if user-facing behavior changed
- [ ] INTEGRATION.md updated if the integration contract changed
- [ ] Tested on at least one mobile device if the widget changed
- [ ] Tested the full solve → verify → siteverify flow manually

---

## Security

If you find a security issue, do not open a public issue. Email the maintainer directly (see <code>package.json</code> for contact) with:

- A description of the issue
- Reproduction steps
- The impact (what an attacker could do)
- Any proposed fix

We aim to respond within 72 hours.

### Scope

In scope:

- Bypasses of the scoring or reputation systems from a **non-browser** client
- Token forgery, replay, or reuse
- SQL injection, XSS, CSRF, SSRF in the API or admin panel
- Secret leakage through logs, responses, or error messages
- CORS or CSP misconfiguration that enables new attacks

Out of scope:

- Bypasses from a **real browser** driven by an AI agent or by a human. This is a fundamental limit of client-side CAPTCHAs, not a bug in irocap.
- Denial of service via high request volume. Use Vercel's platform-level protections.
- Attacks that require the attacker to already know the admin password.

---

## Reporting bugs

Use the GitHub issue tracker. Include:

- What you expected to happen
- What actually happened
- Reproduction steps
- Your environment (browser, OS, Node version)
- The exact error output, if any

If the bug involves the widget, include the DevTools console output and the failing network request (URL, status, response body).

---

## License

By contributing, you agree your contributions are licensed under the MIT license.