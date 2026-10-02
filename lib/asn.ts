import { getSql } from './db.js';

const DATACENTER_ASNS = new Set<number>([
  14618, 16509, 8987, 38895, 17493,
  8075, 12076, 8068, 8069, 3598, 21312,
  15169, 396982, 19527, 139070, 36384,
  14061, 46652, 201229, 393406,
  24940, 213230,
  16276,
  63949, 20940, 8001,
  20473, 21933,
  12876, 51167, 16247, 197540, 40021,
  31898, 13335,
  45102, 37963,
  132203,
  40509,
]);

export interface AsnInfo {
  asn: number | null;
  org: string | null;
  country: string | null;
}

export async function getASN(ip: string): Promise<AsnInfo> {
  const sql = getSql();
  try {
    const cached = (await sql`
      SELECT asn, org, country FROM ip_asn
      WHERE ip = ${ip}::inet AND cached_at > NOW() - INTERVAL '7 days'
      LIMIT 1
    `) as unknown as Array<{ asn: number | null; org: string | null; country: string | null }>;
    if (cached[0]) return cached[0];
  } catch { /* non-fatal */ }

  const token = process.env.IPINFO_TOKEN;
  if (!token) return { asn: null, org: null, country: null };

  try {
    const r = await fetch(`https://ipinfo.io/${ip}/json?token=${token}`);
    if (!r.ok) return { asn: null, org: null, country: null };
    const data = (await r.json()) as Record<string, unknown>;
    const orgStr = typeof data.org === 'string' ? data.org : '';
    const asnMatch = orgStr.match(/^AS(\d+)/);
    const asn = asnMatch ? Number(asnMatch[1]) : null;
    const org = orgStr.replace(/^AS\d+\s*/, '') || null;
    const country = typeof data.country === 'string' ? data.country : null;

    try {
      await sql`
        INSERT INTO ip_asn (ip, asn, org, country, cached_at)
        VALUES (${ip}::inet, ${asn}, ${org}, ${country}, NOW())
        ON CONFLICT (ip) DO UPDATE SET
          asn = ${asn}, org = ${org}, country = ${country}, cached_at = NOW()
      `;
    } catch { /* non-fatal */ }

    return { asn, org, country };
  } catch {
    return { asn: null, org: null, country: null };
  }
}

export function isDatacenterASN(asn: number | null): boolean {
  return asn !== null && DATACENTER_ASNS.has(asn);
}
