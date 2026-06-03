import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  verifyEmailOtpPendingToken, signSessionToken, setSessionCookie, signMfaPendingToken,
} from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

const Body = z.object({
  emailOtpToken: z.string().min(1),
  code: z.string().length(6),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const ip = clientIp(req);
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

  const payload = verifyEmailOtpPendingToken(parsed.data.emailOtpToken);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });

  const rl = await limit({ key: `email-otp:${ip}:${payload.sub}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const codeHash = createHash('sha256').update(parsed.data.code).digest('hex');
  const record = await prisma.emailToken.findFirst({
    where: {
      userId: payload.sub,
      tokenHash: codeHash,
      purpose: 'login_otp',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!record) {
    await writeAudit({ action: 'auth.email_otp.fail', userId: payload.sub, req });
    return res.status(401).json({ error: 'invalid or expired code' });
  }

  // Mark the token used
  await prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: 'user not found' });

  // If TOTP MFA is also enrolled, require that next
  if (user.mfaEnabledAt) {
    await writeAudit({ action: 'auth.email_otp.success', userId: user.id, req });
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
