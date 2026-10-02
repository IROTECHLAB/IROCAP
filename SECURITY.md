# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

Contact the maintainer privately through one of these channels:

- **GitHub Security Advisory** — use the "Report a vulnerability" button on
  the Security tab of https://github.com/IROTECHLAB/irocap (preferred)
- **Telegram** — https://t.me/ironmanhindigaming
- **Instagram DM** — https://instagram.com/ironmanyt00

### What to include

- A description of the issue
- Reproduction steps
- Impact analysis
- Any proposed fix

### Response time

We aim to acknowledge receipt within 72 hours.

---

## Scope

**In scope:**

- Bypasses of scoring or reputation from a non-browser client
- Token forgery, replay, or reuse
- SQL injection, XSS, CSRF, SSRF in API or admin panel
- Secret leakage through logs, responses, or errors
- CORS or CSP misconfiguration that enables new attacks

**Out of scope:**

- Bypasses from a real browser driven by an AI agent or by a human. This is
  a fundamental limit of client-side CAPTCHAs, not a bug in irocap.
- DoS via high request volume (use platform protections).
- Attacks that require the admin password.

---

## Supported versions

Only the latest commit on the default branch is supported.

---

## Disclosure process

1. You report the issue privately.
2. We acknowledge within 72 hours.
3. We confirm or reject and estimate severity.
4. We work on a fix privately.
5. We publish the fix and a security advisory.
6. We credit the reporter unless they request otherwise.
