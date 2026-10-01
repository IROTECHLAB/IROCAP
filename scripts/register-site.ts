/**
 * Register a new site with irocap.
 *
 * Usage:
 *   pnpm tsx scripts/register-site.ts example.com
 *   pnpm tsx scripts/register-site.ts example.com --local
 *
 * Requires admin credentials in the environment:
 *   IROCAP_ADMIN_EMAIL, IROCAP_ADMIN_PASSWORD
 *   (or you'll be prompted interactively)
 */
import 'dotenv/config';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

async function prompt(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (silent) {
      const stdin = process.stdin as NodeJS.ReadStream & {
        isTTY?: boolean;
      };
      if (stdin.isTTY) {
        const onData = (char: Buffer): void => {
          const s = char.toString();
          if (s === '\n' || s === '\r' || s === '\u0004') {
            stdin.removeListener('data', onData);
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (rl as any).output?.write?.('\b \b');
          }
        };
        stdin.on('data', onData);
      }
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const domain = args.find((a) => !a.startsWith('--'));
  const local = args.includes('--local');

  if (!domain) {
    console.error('Usage: pnpm tsx scripts/register-site.ts <domain> [--local]');
    process.exit(1);
  }

  if (local) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error('✗ DATABASE_URL is not set');
      process.exit(1);
    }
    const sql = neon(url);
    const sitekey = randomBytes(16).toString('hex');
    const secret = randomBytes(16).toString('hex');
    await sql`
      INSERT INTO sites (sitekey, secret, domain, active)
      VALUES (${sitekey}, ${secret}, ${domain}, TRUE)
    `;
    console.log('✓ Registered (local):');
    console.log('  domain:  ' + domain);
    console.log('  sitekey: ' + sitekey);
    console.log('  secret:  ' + secret);
    return;
  }

  const base = process.env.IROCAP_BASE_URL || 'http://localhost:3000';

  const email =
    process.env.IROCAP_ADMIN_EMAIL ||
    (await prompt('Admin email: ')).trim().toLowerCase();
  const password =
    process.env.IROCAP_ADMIN_PASSWORD ||
    (await prompt('Admin password: ', true));

  if (!email || !password) {
    console.error('✗ Admin credentials required');
    process.exit(1);
  }

  // 1. Log in.
  const loginRes = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = (await loginRes.json()) as
    | { token: string; email: string; expires_in: number }
    | { error: string };

  if (!loginRes.ok || !('token' in loginBody)) {
    console.error('✗ Login failed:', loginBody);
    process.exit(1);
  }

  // 2. Register the site with the session token.
  const res = await fetch(base + '/api/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + loginBody.token,
    },
    body: JSON.stringify({ domain }),
  });

  const data = (await res.json()) as
    | { sitekey: string; secret: string }
    | { error: string };

  if (!res.ok || !('sitekey' in data)) {
    console.error('✗ Registration failed:', data);
    process.exit(1);
  }

  console.log('✓ Registered:');
  console.log('  domain:  ' + domain);
  console.log('  sitekey: ' + data.sitekey);
  console.log('  secret:  ' + data.secret);
}

main().catch((err: unknown) => {
  console.error('✗ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
