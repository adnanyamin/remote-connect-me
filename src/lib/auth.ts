import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from './db';

const DEV_SECRETS: Record<string, string> = {
  JWT_SECRET: 'change-me-to-a-long-random-string',
  SIGNALING_SECRET: 'dev-signaling-secret-change-me',
};

function requireSecret(name: keyof typeof DEV_SECRETS): string {
  const val = process.env[name];
  if (!val || val === DEV_SECRETS[name]) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `[auth] ${name} is missing or still set to the dev placeholder. ` +
        `Generate one with: openssl rand -hex 32`,
      );
    }
    // In dev, fall back gracefully but warn loudly.
    console.warn(`[auth] WARNING: ${name} is not set — using insecure dev value. Never do this in production.`);
    return DEV_SECRETS[name];
  }
  return val;
}

const JWT_SECRET = requireSecret('JWT_SECRET');
const SIGNALING_SECRET = requireSecret('SIGNALING_SECRET');
const SESSION_COOKIE = 'remotely_session';
const SESSION_TTL_S = 60 * 60 * 24 * 14; // 14 days
const MFA_PENDING_TTL_S = 60 * 5;        // 5 minutes between password and TOTP
const EMAIL_OTP_PENDING_TTL_S = 60 * 10; // 10 minutes to enter email OTP

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

/** Long-lived session JWT for the web user. Stored in an HttpOnly cookie. */
export function signSessionToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'session' }, JWT_SECRET, { expiresIn: SESSION_TTL_S });
}

export function verifySessionToken(token: string): { sub: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; type?: string };
    if (payload.type && payload.type !== 'session') return null;
    return payload;
  } catch { return null; }
}

/**
 * Short-lived "MFA pending" token. Issued right after a correct password when
 * the user has MFA enabled; consumed by /api/auth/mfa/verify in exchange for a
 * real session cookie.
 */
export function signMfaPendingToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'mfa-pending' }, JWT_SECRET, { expiresIn: MFA_PENDING_TTL_S });
}

export function verifyMfaPendingToken(token: string): { sub: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; type: string };
    if (payload.type !== 'mfa-pending') return null;
    return { sub: payload.sub };
  } catch { return null; }
}

/**
 * Short-lived "email OTP pending" token. Issued after correct password;
 * consumed by /api/auth/email-otp/verify in exchange for a real session.
 */
export function signEmailOtpPendingToken(userId: string) {
  return jwt.sign({ sub: userId, type: 'email-otp-pending' }, JWT_SECRET, { expiresIn: EMAIL_OTP_PENDING_TTL_S });
}

export function verifyEmailOtpPendingToken(token: string): { sub: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; type: string };
    if (payload.type !== 'email-otp-pending') return null;
    return { sub: payload.sub };
  } catch { return null; }
}

/**
 * Short-lived JWT for the WebSocket signaling server. Has a deviceId + role
 * baked in so the signaling server knows which "room" to put this socket in.
 */
export function signSignalingToken(opts: {
  userId: string; deviceId: string; role: 'host' | 'viewer';
}) {
  return jwt.sign(
    { sub: opts.userId, deviceId: opts.deviceId, role: opts.role },
    SIGNALING_SECRET,
    { expiresIn: 60 * 5 } // 5 minutes
  );
}

export function setSessionCookie(res: NextApiResponse, token: string) {
  const cookie = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_S}`,
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookie);
}

export function clearSessionCookie(res: NextApiResponse) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

function readCookie(req: NextApiRequest, name: string): string | null {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Pulls the user from the session cookie. Returns null if not signed in. */
export async function getSessionUser(req: NextApiRequest) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  return prisma.user.findUnique({ where: { id: payload.sub } });
}

/** Authenticates a request from the Electron client via Bearer device key. */
export async function getDeviceFromAuthHeader(req: NextApiRequest) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const presented = auth.slice('Bearer '.length).trim();
  const dot = presented.indexOf('.');
  if (dot < 0) return null;
  const deviceId = presented.slice(0, dot);
  const secret = presented.slice(dot + 1);
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return null;
  const ok = await bcrypt.compare(secret, device.deviceKeyHash);
  return ok ? device : null;
}

/**
 * Authenticates an Electron client request, accepting credentials from either:
 *   - Authorization: Bearer <deviceId>.<secret>  (new clients v0.1.27+)
 *   - POST body { deviceId, deviceKey }           (legacy clients before v0.1.27)
 */
export async function getDeviceFromRequest(req: NextApiRequest) {
  // Prefer header auth
  const fromHeader = await getDeviceFromAuthHeader(req);
  if (fromHeader) return fromHeader;

  // Fall back to body auth for legacy clients
  const { deviceId, deviceKey } = req.body ?? {};
  if (!deviceId || !deviceKey) return null;
  const device = await prisma.device.findUnique({ where: { id: String(deviceId) } });
  if (!device) return null;
  const dot = String(deviceKey).indexOf('.');
  const secret = dot >= 0 ? String(deviceKey).slice(dot + 1) : '';
  const ok = await bcrypt.compare(secret, device.deviceKeyHash);
  return ok ? device : null;
}

/** Generates a (device key, hash) pair. The plaintext is returned to the client once. */
export async function generateDeviceKey(deviceId: string) {
  const secret = randomToken(40);
  const hash = await bcrypt.hash(secret, 10);
  return { plaintext: `${deviceId}.${secret}`, hash };
}

export function randomToken(bytes: number) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('crypto');
  return randomBytes(bytes).toString('base64url');
}

/** Short, human-friendly pair code: 8 uppercase chars, no ambiguous letters. */
export function generatePairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomInt } = require('crypto');
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}
