import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  signSessionToken, setSessionCookie, verifyMfaPendingToken,
} from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';
import {
  verifyTotp, fromBase32, hashRecoveryCode, unpackRecovery,
} from '@/lib/totp';

/**
 * Login-time MFA step. Trades a valid mfa-pending token + TOTP code (or one of
 * the user's single-use recovery codes) for a real session cookie.
 */
const Body = z.object({
  mfaToken: z.string().min(10),
  code: z.string().min(6).max(20),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const ip = clientIp(req);
  // Rate limit by IP — abuse here looks like brute-forcing the 6-digit code.
  const rl = await limit({ key: `mfa-verify:${ip}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many MFA attempts, try again later' });
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const payload = verifyMfaPendingToken(parsed.data.mfaToken);
  if (!payload) return res.status(401).json({ error: 'mfa session expired — sign in again' });

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.mfaEnabledAt || !user.mfaSecret) {
    return res.status(401).json({ error: 'mfa not configured' });
  }

  const code = parsed.data.code.trim();
  let accepted: 'totp' | 'recovery' | null = null;

  // 1) Try TOTP (6 digits)
  if (/^\d{6}$/.test(code) && verifyTotp(fromBase32(user.mfaSecret), code)) {
    accepted = 'totp';
  }

  // 2) Try recovery code
  if (!accepted) {
    const codes = unpackRecovery(user.mfaRecoveryCodes);
    const target = hashRecoveryCode(code);
    const idx = codes.findIndex((c) => c.hash === target && !c.usedAt);
    if (idx >= 0) {
      codes[idx].usedAt = new Date().toISOString();
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaRecoveryCodes: JSON.stringify(codes) },
      });
      accepted = 'recovery';
    }
  }

  if (!accepted) {
    await writeAudit({ action: 'auth.mfa.fail', userId: user.id, req });
    return res.status(401).json({ error: 'wrong code' });
  }

  setSessionCookie(res, signSessionToken(user.id));
  await writeAudit({
    action: accepted === 'recovery' ? 'auth.mfa.recovery_used' : 'auth.mfa.success',
    userId: user.id, req,
  });
  await writeAudit({ action: 'auth.login.success', userId: user.id, req });
  return res.status(200).json({
    id: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    mfaEnabled: true,
    via: accepted,
  });
}
