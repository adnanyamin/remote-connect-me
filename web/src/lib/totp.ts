import { createHmac, createHash, randomBytes } from 'crypto';

/**
 * Self-contained TOTP (RFC 6238) implementation. No external dependencies.
 *
 *   - 30-second time step
 *   - 6-digit codes
 *   - SHA-1 (the de-facto standard that authenticator apps support universally)
 *   - +/- 1 step verification window for clock skew
 *
 * Recovery codes are random hex tokens; we store SHA-256 hashes plus a usedAt
 * flag and treat the plaintext as one-time. Recovery codes have full entropy
 * so bcrypt-style slow hashing is unnecessary.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): { base32: string; bytes: Buffer } {
  const bytes = randomBytes(20);
  return { base32: toBase32(bytes), bytes };
}

export function toBase32(buf: Buffer): string {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += B32[parseInt(chunk, 2)];
  }
  return out;
}

export function fromBase32(s: string): Buffer {
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('invalid base32 character: ' + c);
    bits += i.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotpAt(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 8-byte big-endian counter (we only use 32 bits; high half is zero)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24 |
     (hmac[offset + 1] & 0xff) << 16 |
     (hmac[offset + 2] & 0xff) << 8 |
     (hmac[offset + 3] & 0xff))
    % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export function totpAt(secret: Buffer, atMillis = Date.now()): string {
  const counter = Math.floor(atMillis / 1000 / STEP_SECONDS);
  return hotpAt(secret, counter);
}

/** Constant-time compare two equal-length strings. */
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a code, tolerating +/- window steps of clock skew. */
export function verifyTotp(secret: Buffer, code: string, window = 1): boolean {
  const now = Date.now();
  const trimmed = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return false;
  for (let i = -window; i <= window; i++) {
    const candidate = totpAt(secret, now + i * STEP_SECONDS * 1000);
    if (ctEq(candidate, trimmed)) return true;
  }
  return false;
}

/** Build an otpauth:// URL suitable for authenticator QR codes. */
export function otpauthUrl(opts: { issuer: string; account: string; secret: string }) {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
    algorithm: 'SHA1',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Generate N random recovery codes formatted as `xxxx-xxxx-xx`. */
export function generateRecoveryCodes(n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = randomBytes(5);
    out.push(b.toString('hex').match(/.{1,4}/g)!.join('-'));
  }
  return out;
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

export interface StoredRecovery { hash: string; usedAt: string | null; }

export function packRecovery(codes: string[]): string {
  return JSON.stringify(codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })));
}

export function unpackRecovery(json: string | null): StoredRecovery[] {
  if (!json) return [];
  try { return JSON.parse(json) as StoredRecovery[]; }
  catch { return []; }
}
