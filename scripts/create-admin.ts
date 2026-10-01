/**
 * Create an admin user for irocap.
 *
 * Usage:
 *   pnpm tsx scripts/create-admin.ts admin@example.com
 *   # or non-interactively:
 *   IROCAP_ADMIN_EMAIL=admin@example.com IROCAP_ADMIN_PASSWORD=... \
 *     pnpm tsx scripts/create-admin.ts
 */
import 'dotenv/config';
import readline from 'node:readline';
import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../lib/admin.js';

async function prompt(question: string, silent = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (silent) {
      // Disable echo for password entry.
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
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✗ DATABASE_URL is not set');
    process.exit(1);
  }

  const emailArg = process.argv[2];
  const email = (
    emailArg ||
    process.env.IROCAP_ADMIN_EMAIL ||
    (await prompt('Admin email: '))
  )
    .trim()
    .toLowerCase();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('✗ Invalid email');
    process.exit(1);
  }

  let password =
    process.env.IROCAP_ADMIN_PASSWORD ||
    (await prompt('Admin password (min 8 chars): ', true));

  if (!password || password.length < 8) {
    console.error('✗ Password must be at least 8 characters');
    process.exit(1);
  }

  const sql = neon(url);

  const existing = (await sql`
    SELECT id FROM admin_users WHERE email = ${email} LIMIT 1
  `) as Array<{ id: number }>;

  if (existing.length > 0) {
    console.error(`✗ Admin with email ${email} already exists (id=${existing[0]!.id})`);
    process.exit(1);
  }

  const { hash, salt } = await hashPassword(password);

  await sql`
    INSERT INTO admin_users (email, password_hash, password_salt, active)
    VALUES (${email}, ${hash}, ${salt}, TRUE)
  `;

  // Best-effort scrub of the password from memory.
  password = '';

  console.log('✓ Admin user created');
  console.log('  email: ' + email);
}

main().catch((err: unknown) => {
  console.error('✗ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
