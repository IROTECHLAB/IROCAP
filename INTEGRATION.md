# irocap Integration Guide

Complete reference for embedding irocap on any site and verifying tokens
server-side.

---

## Table of contents

1. Overview
2. Quick start
3. Widget API
4. Server-side verification
5. Backend examples
6. Reading the response
7. Error handling
8. Security best practices
9. Multi-domain setup
10. Testing
11. Performance
12. Troubleshooting
13. FAQ

---

## Overview

irocap is a privacy-first Proof-of-Work CAPTCHA. The visitor never sees a
puzzle — a Web Worker solves a SHA-256 hash challenge silently in the
background. Suspicious traffic is scored and challenged harder.

The flow:

1. The widget loads <code>/irocap.js</code> from the irocap deployment.
2. It requests a challenge from <code>POST /api/challenge</code>.
3. A Web Worker solves the puzzle (SHA-256 brute force).
4. The widget POSTs the solution and signals to <code>/api/verify</code>.
5. The server signs a token and returns it.
6. The widget inserts the token into a hidden form field.
7. Your backend calls <code>POST /api/siteverify</code> to verify it.

The solver runs in a Web Worker, so the main thread stays responsive.
Visitors can continue filling out the form while the challenge is solved in
the background.

---

## Quick start

### Step 1 — Get a sitekey

1. Open your irocap deployment at <code>/admin.html</code>
2. Sign in with your admin credentials
3. Under **Register a site**, enter your domain
4. Copy the **sitekey** (public) and **secret** (server-only)

The **sitekey** goes in your HTML. The **secret** goes in your server's
environment variables. Never put the secret in client-side code.

### Step 2 — Add the widget

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

The widget inserts <code>&lt;input type="hidden" name="irocap-token"&gt;</code>
into the enclosing form automatically.

### Step 3 — Verify server-side

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

That is the entire integration.

---

## Widget API

### Constructor

<pre><code>new Irocap(sitekey, options)</code></pre>

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| <code>sitekey</code> | string | Yes | Public sitekey from the admin panel |
| <code>options.container</code> | string or Element | Yes | CSS selector or DOM element for the badge |
| <code>options.callback</code> | function | No | Fired on success: <code>(token, score)</code> |
| <code>options['error-callback']</code> | function | No | Fired on failure: <code>(err)</code> |
| <code>options.base</code> | string | No | Override the irocap base URL |

### Callbacks

Success:

<pre><code>new Irocap('YOUR_SITEKEY', {
  container: '.irocap',
  callback: function (token, score) {
    console.log('token:', token);
    console.log('score:', score);
  }
});</code></pre>

Failure:

<pre><code>new Irocap('YOUR_SITEKEY', {
  container: '.irocap',
  'error-callback': function (err) {
    console.warn('irocap failed:', err.stage, err.error);
  }
});</code></pre>

Error shapes:

- <code>{ stage: 'challenge', status: 404, error: 'unknown-sitekey' }</code>
- <code>{ stage: 'solve', error: 'worker-solve-timeout' }</code>
- <code>{ stage: 'verify', status: 403, error: 'bot-detected' }</code>
- <code>{ stage: 'network', error: '...' }</code>

### The badge

Renders inside <code>options.container</code>.

| State | Appearance |
| --- | --- |
| Solving | grey spinner, "Verifying…" |
| Success | green check, "Verified" |
| Failure | red X, "Failed" |

Inline styles only. No layout shift.

### The hidden input

On success, the widget inserts into the nearest ancestor form:

<pre><code>&lt;input type="hidden" name="irocap-token" value="eyJ..."&gt;</code></pre>

If you use a SPA or fetch-based form submit, capture the token from the
callback instead of relying on the hidden input.

### Solve strategy

The widget tries three solver paths in order:

1. Web Worker + WASM SHA-256
2. Web Worker + inline JS SHA-256
3. <code>crypto.subtle.digest</code> on the main thread

All three produce identical hashes. No configuration is needed. The path
used is reported in the <code>method</code> signal (<code>wasm</code>,
<code>js</code>, or <code>webcrypto</code>) for server-side scoring.

---

## Server-side verification

### Endpoint

<pre><code>POST https://your-deployment.vercel.app/api/siteverify</code></pre>

### Request

<pre><code>Content-Type: application/json

{
  "secret": "your-32-hex-secret",
  "response": "eyJhbGciOiJIUzI1NiIs...",
  "remoteip": "203.0.113.42"
}</code></pre>

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| <code>secret</code> | string | Yes | Server-only. Never expose. |
| <code>response</code> | string | Yes | The <code>irocap-token</code> from the form |
| <code>remoteip</code> | string | No | Visitor's IP. Reserved for future scoring. |

### Response — success

<pre><code>{
  "success": true,
  "score": 0.9,
  "sitekey": "d83591de15e4596447a028b7a3a6a136",
  "challenge_ts": "2026-10-01T12:34:56.789Z"
}</code></pre>

### Response — failure

<pre><code>{
  "success": false,
  "error-codes": ["already-used"]
}</code></pre>

### Single-use tokens

Every token can be verified exactly once. The second call returns:

<pre><code>{"success": false, "error-codes": ["already-used"]}</code></pre>

Enforced by an atomic <code>UPDATE ... WHERE used=FALSE RETURNING</code> on
the server. Do not retry verification on failure — treat the second call as
an attempted replay.

### Token expiry

Tokens expire 5 minutes after they are issued. If more than 5 minutes pass
between the solve and the verify, the response is:

<pre><code>{"success": false, "error-codes": ["expired"]}</code></pre>

Ask the visitor to refresh and try again. Do not increase the TTL — 5
minutes is intentional. Longer TTLs increase the replay window.

---

## Backend examples

### Express (Node.js)

<pre><code>const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/submit', async (req, res) =&gt; {
  const token = req.body['irocap-token'];
  if (!token) return res.status(400).send('Missing CAPTCHA token');

  const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.IROCAP_SECRET,
      response: token,
      remoteip: req.ip
    })
  });
  const result = await r.json();

  if (!result.success || result.score &lt; 0.5) {
    return res.status(400).send('CAPTCHA verification failed');
  }

  await saveEmail(req.body.email);
  res.send('Signed up!');
});</code></pre>

### Express middleware

<pre><code>async function requireIrocap(req, res, next) {
  const token = req.body['irocap-token'];
  if (!token) return res.status(400).json({ error: 'missing-captcha' });

  const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.IROCAP_SECRET,
      response: token,
      remoteip: req.ip
    })
  });
  const result = await r.json();

  if (!result.success) {
    return res.status(400).json({ error: 'captcha-failed' });
  }
  if (result.score &lt; 0.5) {
    return res.status(403).json({ error: 'captcha-suspicious' });
  }

  req.irocap = { score: result.score };
  next();
}</code></pre>

### Next.js (Pages Router)

<pre><code>export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.IROCAP_SECRET,
      response: req.body['irocap-token'],
      remoteip: req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    })
  });
  const result = await r.json();

  if (!result.success || result.score &lt; 0.5) {
    return res.status(400).json({ error: 'captcha-failed' });
  }
  res.json({ ok: true });
}</code></pre>

### Next.js (App Router)

<pre><code>export async function POST(request) {
  const body = await request.json();

  const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.IROCAP_SECRET,
      response: body['irocap-token'],
      remoteip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    })
  });
  const result = await r.json();

  if (!result.success || result.score &lt; 0.5) {
    return Response.json({ error: 'captcha-failed' }, { status: 400 });
  }
  return Response.json({ ok: true });
}</code></pre>

### Fastify

<pre><code>const fastify = require('fastify')();
fastify.register(require('@fastify/formbody'));

fastify.post('/submit', async (req, reply) =&gt; {
  const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
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
    return reply.code(400).send({ error: 'captcha-failed' });
  }
  reply.send({ ok: true });
});</code></pre>

### Cloudflare Workers

<pre><code>export default {
  async fetch(request, env) {
    const form = await request.formData();
    const token = form.get('irocap-token');

    const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.IROCAP_SECRET,
        response: token,
        remoteip: request.headers.get('CF-Connecting-IP')
      })
    });
    const result = await r.json();

    if (!result.success || result.score &lt; 0.5) {
      return new Response('CAPTCHA failed', { status: 400 });
    }
    return new Response('OK');
  }
};</code></pre>

### PHP

<pre><code>&lt;?php
function verify_irocap($token, $secret, $remoteIp = null) {
    $payload = json_encode([
        'secret'   =&gt; $secret,
        'response' =&gt; $token,
        'remoteip' =&gt; $remoteIp,
    ]);

    $ch = curl_init('https://your-deployment.vercel.app/api/siteverify');
    curl_setopt_array($ch, [
        CURLOPT_POST           =&gt; true,
        CURLOPT_POSTFIELDS     =&gt; $payload,
        CURLOPT_HTTPHEADER     =&gt; ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER =&gt; true,
        CURLOPT_TIMEOUT        =&gt; 5,
    ]);
    $response = curl_exec($ch);
    curl_close($ch);
    return json_decode($response, true);
}

$result = verify_irocap(
    $_POST['irocap-token'],
    getenv('IROCAP_SECRET'),
    $_SERVER['REMOTE_ADDR']
);

if (!$result['success'] || $result['score'] &lt; 0.5) {
    http_response_code(400);
    exit('CAPTCHA failed');
}</code></pre>

### Python (Flask)

<pre><code>import os
import requests
from flask import Flask, request

app = Flask(__name__)

@app.route('/submit', methods=['POST'])
def submit():
    token = request.form.get('irocap-token')
    r = requests.post(
        'https://your-deployment.vercel.app/api/siteverify',
        json={
            'secret': os.environ['IROCAP_SECRET'],
            'response': token,
            'remoteip': request.remote_addr,
        },
        timeout=5,
    )
    result = r.json()

    if not result.get('success') or result.get('score', 0) &lt; 0.5:
        return 'CAPTCHA failed', 400
    return 'OK'</code></pre>

### Go (net/http)

<pre><code>package main

import (
    "bytes"
    "encoding/json"
    "net/http"
)

type SiteVerifyRequest struct {
    Secret   string `json:"secret"`
    Response string `json:"response"`
    RemoteIP string `json:"remoteip,omitempty"`
}

type SiteVerifyResponse struct {
    Success     bool     `json:"success"`
    Score       float64  `json:"score"`
    Sitekey     string   `json:"sitekey"`
    ChallengeTS string   `json:"challenge_ts"`
    ErrorCodes  []string `json:"error-codes"`
}

func verifyIrocap(token, secret, ip string) (*SiteVerifyResponse, error) {
    body, _ := json.Marshal(SiteVerifyRequest{
        Secret:   secret,
        Response: token,
        RemoteIP: ip,
    })
    resp, err := http.Post(
        "https://your-deployment.vercel.app/api/siteverify",
        "application/json",
        bytes.NewReader(body),
    )
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var out SiteVerifyResponse
    if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
        return nil, err
    }
    return &amp;out, nil
}</code></pre>

### Ruby (Rails)

<pre><code>require 'net/http'
require 'json'

def verify_irocap(token, secret, remote_ip)
  uri = URI('https://your-deployment.vercel.app/api/siteverify')
  res = Net::HTTP.post(
    uri,
    { secret: secret, response: token, remoteip: remote_ip }.to_json,
    'Content-Type' =&gt; 'application/json'
  )
  JSON.parse(res.body)
end

result = verify_irocap(
  params['irocap-token'],
  ENV['IROCAP_SECRET'],
  request.remote_ip
)

unless result['success'] &amp;&amp; result['score'].to_f &gt;= 0.5
  return render plain: 'CAPTCHA failed', status: :bad_request
end</code></pre>

### WordPress

<pre><code>add_action('wp_ajax_nopriv_my_form', 'my_form_handler');
add_action('wp_ajax_my_form', 'my_form_handler');

function my_form_handler() {
    $token = sanitize_text_field($_POST['irocap-token'] ?? '');
    $result = verify_irocap(
        $token,
        getenv('IROCAP_SECRET'),
        $_SERVER['REMOTE_ADDR']
    );

    if (!$result['success'] || $result['score'] &lt; 0.5) {
        wp_send_json_error(['message' =&gt; 'CAPTCHA failed'], 400);
    }

    wp_send_json_success(['message' =&gt; 'OK']);
}</code></pre>

---

## Reading the response

### <code>success</code>

Boolean. <code>true</code> means the token is valid, unused, and unexpired.
<code>false</code> means reject the request.

### <code>score</code>

Float in <code>[0.0, 1.0]</code>. Higher is better.

| Range | Meaning | Suggested action |
| --- | --- | --- |
| 0.8 – 1.0 | Very likely human | Accept |
| 0.5 – 0.8 | Probably human | Accept |
| 0.3 – 0.5 | Mildly suspicious | Accept with rate limit |
| 0.0 – 0.3 | Likely bot | Reject |

Recommended default: <code>score &gt;= 0.5</code>.

Lower to <code>&gt;= 0.3</code> if you see false positives on real users.
Raise to <code>&gt;= 0.7</code> if under attack and you can tolerate
friction.

### How the score is computed

Every solve reports two families of signals.

Server-observed (un-spoofable):

- User-Agent, Accept-Language, <code>sec-ch-ua</code>,
  <code>sec-fetch-*</code>, Origin, Referer
- Elapsed time between challenge issue and verify
- ASN / datacenter status of the source IP
- Fingerprint and IP reputation history

Client-claimed (used as tie-breakers):

- Mouse / keyboard counts, time-to-interact
- Canvas and WebGL hints
- Event stream (mouse positions, keys, scroll)

The final score is
<code>min(trusted, consistency, behavior, fingerprint, ip_reputation)</code>.
The worst signal wins — one clear evidence of automation caps the score.

### <code>challenge_ts</code>

ISO 8601 timestamp of when the challenge was issued. Useful for audit logs.

---

## Error handling

| Code | HTTP | Meaning | Action |
| --- | --- | --- | --- |
| <code>invalid-secret</code> | 403 | Secret is wrong or site inactive | Check env var; ensure site is active |
| <code>invalid-token</code> | 400 | Token malformed or wrong sitekey | Reject |
| <code>already-used</code> | 400 | Token already consumed | Replay attempt — reject and log |
| <code>expired</code> | 400 | Token older than 5 minutes | Ask visitor to refresh |
| <code>method-not-allowed</code> | 405 | You used GET | Use POST |
| <code>internal-error</code> | 500 | Server-side issue | Retry; log and investigate |

Recommended handling:

<pre><code>const result = await verifyIrocap(token, secret, ip);

if (!result.success) {
  const code = (result['error-codes'] || [])[0] || 'unknown';
  switch (code) {
    case 'expired':
      return res.status(400).send('Session expired — refresh and try again');
    case 'already-used':
      console.warn('Replay attempt from', ip);
      return res.status(400).send('Verification failed');
    case 'invalid-secret':
      console.error('IROCAP_SECRET is misconfigured');
      return res.status(500).send('Server error');
    default:
      return res.status(400).send('Verification failed');
  }
}

if (result.score &lt; 0.5) {
  return res.status(403).send('Request flagged as suspicious');
}</code></pre>

Never expose the exact error code to the visitor. Log it server-side and
show a generic message.

---

## Security best practices

1. **Never expose the secret.** Server-side environment variables only.
   Rotate immediately if leaked.
2. **Verify on the server.** Client-side verification is worthless. The
   widget's callback is a hint.
3. **Enforce a score threshold.** A <code>success: true</code> with a low
   score still means a likely bot. Check both.
4. **Respect single-use.** Do not retry verification on failure.
5. **Rate limit your own endpoints.** irocap handles CAPTCHA rate limiting;
   your signup/login endpoints still need their own throttling.
6. **Log suspicious activity.** A burst of <code>already-used</code> errors
   from one IP is a replay signal. Alert on it.
7. **Use HTTPS.** Never embed the widget on HTTP pages.
8. **Configure CSP.** Allow <code>worker-src blob:</code> and
   <code>connect-src</code> to the irocap host.
9. **Handle network failures.** Decide strict (reject) or lenient (allow)
   based on the form's value.
10. **Rotate secrets periodically.** Use the admin panel's **Regenerate
    secret**.

### Content Security Policy

If your site uses CSP, allow:

<pre><code>script-src 'self' https://your-deployment.vercel.app;
connect-src 'self' https://your-deployment.vercel.app;
worker-src blob:;</code></pre>

<code>worker-src blob:</code> is required because the widget creates the Web
Worker from a Blob URL. Without it, the worker fails and the widget falls
back to a slower solver tier.

---

## Multi-domain setup

Register a separate sitekey for each domain:

<pre><code>example.com       =&gt;  sitekey_abc  secret_xyz
app.example.com   =&gt;  sitekey_def  secret_uvw
blog.example.com  =&gt;  sitekey_ghi  secret_rst</code></pre>

Register each in the admin panel and copy the sitekey into the correct
deployment.

If you manage multiple environments (staging / production), give each its
own sitekey. Never share secrets across subdomains — if one leaks, only that
domain is affected.

---

## Testing

### Node-based end-to-end test

<pre><code>const crypto = require('crypto');

async function testIrocap(baseUrl, sitekey, secret) {
  // 1. Challenge
  const ch = await fetch(baseUrl + '/api/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sitekey })
  }).then(r =&gt; r.json());

  // 2. Solve
  const prefix = '0'.repeat(ch.difficulty);
  let nonce = 0;
  let hash;
  while (true) {
    hash = crypto
      .createHash('sha256')
      .update(ch.challenge + nonce)
      .digest('hex');
    if (hash.startsWith(prefix)) break;
    nonce++;
  }

  // 3. Verify
  const ver = await fetch(baseUrl + '/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge: ch.challenge,
      issuedAt: ch.issuedAt,
      sig: ch.sig,
      nonce,
      hash,
      signals: {
        webdriver: false,
        touchSupport: true,
        mouseMovements: 42,
        keyPresses: 7,
        timeToInteract: 1200,
        canvasHash: 'deadbeef',
        webglVendor: 'test',
        screenSize: '1920x1080',
        colorDepth: 24,
        language: 'en-US',
        timezone: 'UTC',
        hardwareConcurrency: 8,
        method: 'wasm',
        solveMs: 100,
        pluginsCount: 3,
        events: []
      }
    })
  }).then(r =&gt; r.json());

  // 4. Siteverify
  const sv = await fetch(baseUrl + '/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, response: ver.token })
  }).then(r =&gt; r.json());

  console.log('Result:', sv);
}</code></pre>

Node-based tests often trip the bot-detection layer because they don't send
real browser headers. Use them to test the wire protocol, not the scoring.

### Browser test

1. Open your form in a browser.
2. Open DevTools → Network tab.
3. Filter by <code>irocap</code>.
4. Submit the form and watch for:
   - <code>POST /api/challenge</code> returning 200
   - <code>POST /api/verify</code> returning 200 with a token
   - The form submission including <code>irocap-token</code>

### Test scenarios

| Scenario | Expected |
| --- | --- |
| Fresh browser, real user | Success, high score |
| Same user, second visit | Success, high score (fingerprint) |
| curl / Node fetch | 403 <code>bot-detected</code> |
| Puppeteer with default settings | 403 <code>bot-detected</code> |
| Token reused | <code>already-used</code> |
| Token after 5+ minutes | <code>expired</code> |

---

## Performance

Solve time depends on the visitor's device, browser, and network. It is
dominated by the SHA-256 brute force loop, which runs in a Web Worker.

**What is guaranteed:**

- The solver never blocks the main thread. The page remains interactive
  while the challenge is solved.
- There is no visible timer. The visitor sees a "Verifying…" badge and can
  continue filling out the form.
- The widget has a three-tier fallback chain (WASM → inline JS →
  <code>crypto.subtle</code>). If one tier times out, the next one starts.
- The default difficulty (5) means roughly one million average hash
  attempts to find a valid nonce.

**What varies:**

- Actual solve time depends on the device's CPU and whether WASM loaded
  successfully.
- Modern desktops and recent flagships typically solve quickly.
- Budget and older mobile devices can take noticeably longer.
- If the visitor's browser blocks Web Workers (rare, usually CSP-related),
  the widget falls back to <code>crypto.subtle</code> on the main thread,
  which is slower.

**What to do if solves feel too slow:**

Lower the base difficulty in <code>api/challenge.ts</code>:

<pre><code>const BASE_DIFFICULTY = 5;   // change to 4 for faster solves</code></pre>

Each step down halves the average solve time and halves the average bot
cost. There is no free lunch.

---

## Troubleshooting

### Badge shows Failed

Check the DevTools Network tab.

| Response | Cause | Fix |
| --- | --- | --- |
| <code>/api/challenge</code> 404 | Sitekey not registered | Register in admin panel |
| <code>/api/challenge</code> 429 | Rate limited | Wait 60 seconds |
| <code>/api/verify</code> 403 | Bot detected | Verify you are testing in a real browser; check CSP |
| <code>/api/verify</code> 400 | Bad signature | Reload the page |
| No request appears | Script did not load | Check <code>&lt;script src&gt;</code> and the console |

### Badge stuck on "Verifying…"

- On very slow devices, the badge can remain on "Verifying…" for a while
  before falling back to a slower solver tier or timing out.
- The widget tries WASM first, then inline JS, then <code>crypto.subtle</code>.
- If it never completes, verify that
  <code>/wasm/sha256.umd.min.js</code> is reachable (HTTP 200).
- Check that your CSP allows <code>worker-src blob:</code> and
  <code>script-src 'self'</code>.

### Score is unexpectedly low

Watch the server logs. Look for lines starting with
<code>[irocap]</code>. Each names the check that fired:

- <code>[irocap] consistency flags</code>
- <code>[irocap] behavior flags</code>
- <code>[irocap] datacenter asn</code>
- <code>[irocap] bot rejected</code>

If real users are being penalized by a specific rule, the threshold for that
rule needs tuning.

### Server returns <code>invalid-secret</code>

Possible causes:

1. Env var mismatch — the <code>IROCAP_SECRET</code> value differs from what
   the admin panel shows.
2. The site was deactivated in the admin panel.
3. The secret was rotated recently and your server still uses the old one.

### Server returns <code>already-used</code> on the first call

Three possible causes:

1. Your code is calling <code>/api/siteverify</code> twice (double-submit,
   middleware retry).
2. Your framework auto-retries on 5xx errors.
3. The token was stolen and used elsewhere.

Add logging around your siteverify call to count invocations per form
submission.

### Server returns <code>expired</code>

The token is more than 5 minutes old. Show the visitor a message asking them
to reload and resubmit. Do not increase the TTL — 5 minutes is intentional.

### Widget never renders

- Does the <code>&lt;script src&gt;</code> load? (Check Network tab.)
- Does <code>new Irocap(...)</code> run without errors? (Check console.)
- Does <code>options.container</code> match an element that exists at
  script-run time?

If the script runs before the container exists, wrap it:

<pre><code>document.addEventListener('DOMContentLoaded', function () {
  new Irocap('YOUR_SITEKEY', { container: '.irocap' });
});</code></pre>

### CSP blocks the worker

The widget creates a Web Worker from a Blob URL. If your CSP does not
include <code>worker-src blob:</code>, the worker fails and the widget falls
back to <code>crypto.subtle</code> on the main thread.

Add to your CSP:

<pre><code>worker-src blob: 'self';</code></pre>

### CORS errors

The widget sends <code>Content-Type: application/json</code>, which triggers
a CORS preflight. irocap's API answers preflights on all widget-facing
endpoints. If you see a CORS error:

- Confirm the deployment URL in your <code>&lt;script src&gt;</code> matches
  the deployment URL in your config.
- Confirm the irocap deployment is reachable from your origin (curl the
  <code>OPTIONS</code> preflight from your browser's DevTools Network tab).

---

## FAQ

### Does irocap track users?

No cookies, no third-party scripts, no analytics, no cross-site
identification. A canvas hash is computed locally and used only for bot
detection. Tokens expire in 5 minutes.

### Does it work with React, Vue, Svelte, etc.?

Yes. Load the script, mount a container, instantiate the widget in the
appropriate lifecycle hook.

React example:

<pre><code>import { useEffect, useRef } from 'react';

export function IrocapWidget({ sitekey }) {
  const ref = useRef(null);

  useEffect(() =&gt; {
    if (!window.Irocap || !ref.current) return;
    new window.Irocap(sitekey, { container: ref.current });
  }, [sitekey]);

  return &lt;div ref={ref} /&gt;;
}</code></pre>

Vue example:

<pre><code>&lt;template&gt;
  &lt;div ref="container" /&gt;
&lt;/template&gt;

&lt;script setup&gt;
import { onMounted, ref } from 'vue';

const props = defineProps(['sitekey']);
const container = ref(null);

onMounted(() =&gt; {
  new window.Irocap(props.sitekey, { container: container.value });
});
&lt;/script&gt;</code></pre>

### Can I self-host irocap?

Yes. It is a Vercel project. Deploy it to your own account, point the
<code>&lt;script src&gt;</code> to your domain, and manage your own Neon DB.

### What happens if irocap goes down?

Your server's <code>fetch</code> to <code>/api/siteverify</code> fails.
Choose strict (reject) or lenient (allow) at the call site.

For high-value forms (banking, account creation), be strict. For low-value
forms (newsletter signup, comments), be lenient.

### Can I test without a real browser?

Yes, but Node-based tests often trip the bot-detection layer because they
do not send real browser headers. Use them to test the wire protocol, not
the scoring.

### What is the token TTL?

5 minutes. Challenges also expire after 5 minutes. Both windows are
deliberate.

### Can I use the same sitekey for multiple forms?

Yes. One sitekey per domain, any number of forms. Tokens are unique per
solve, so there is no interference.

### Does it work offline or with a service worker?

No. The widget must reach <code>/api/challenge</code> and
<code>/api/verify</code>. Exclude those routes from your service worker
cache.

### Can I customize the badge?

Not currently. It is intentionally minimal so it fits any design. Fork
<code>public/irocap.js</code> if you need customization.

---

## Quick reference

Widget embed:

<pre><code>&lt;script src="https://your-deployment.vercel.app/irocap.js"&gt;&lt;/script&gt;
&lt;div class="irocap"&gt;&lt;/div&gt;
&lt;script&gt;
  new Irocap('YOUR_SITEKEY', { container: '.irocap' });
&lt;/script&gt;</code></pre>

Server verification:

<pre><code>const r = await fetch('https://your-deployment.vercel.app/api/siteverify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    secret: process.env.IROCAP_SECRET,
    response: req.body['irocap-token'],
    remoteip: req.ip
  })
});
const { success, score } = await r.json();
if (!success || score &lt; 0.5) return reject();</code></pre>

Key values:

- Recommended score threshold: 0.5
- Token TTL: 5 minutes
- Rate limit: 60 challenges/min per IP per sitekey
- Default difficulty: 5
- Required CSP: <code>worker-src blob:</code> and
  <code>connect-src https://your-deployment.vercel.app</code>

---

## Support

- Admin panel: <code>/admin.html</code> on your deployment.
- When reporting issues, include the exact <code>/api/siteverify</code>
  response and any <code>[irocap]</code> warnings from the server logs.