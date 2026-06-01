import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  verifyPassword, signSessionToken, setSessionCookie, signMfaPendingToken,
} from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const ip = clientIp(req);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const normalized = parsed.data.email.toLowerCase();

  const rl = await limit({ key: `login:${ip}:${normalized}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    await writeAudit({
      action: 'auth.login.fail', req,
      metadata: { email: normalized, result: 'rate_limited', locked: rl.locked },
    });
    return res.status(429).json({ error: 'too many login attempts, try again later' });
  }

  const user = await prisma.user.findUnique({ where: { email: normalized } });
  const ok = user
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : await verifyPassword(parsed.data.password, '$2a$10$abcdefghijklmnopqrstuv');
  if (!user || !ok) {
    await writeAudit({
      action: 'auth.login.fail', req,
      metadata: { email: normalized, userId: user?.id },
    });
    return res.status(401).json({ error: 'invalid email or password' });
  }

  // If MFA is enrolled, do NOT issue a session — return a short-lived
  // mfa-pending token instead. The client then POSTs it + the TOTP code
  // to /api/auth/mfa/verify to get the real cookie.
  if (user.mfaEnabledAt) {
    await writeAudit({ action: 'auth.mfa.required', userId: user.id, req });
    return res.status(200).json({
      mfa_required: true,
      mfaToken: signMfaPendingToken(user.id),
    });
  }

  setSessionCookie(res, signSessionToken(user.id));
  await writeAudit({ action: 'auth.login.success', userId: user.id, req });
  return res.status(200).json({
    id: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    mfaEnabled: false,
  });
}
