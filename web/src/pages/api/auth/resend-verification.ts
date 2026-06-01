import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { limit, BUCKETS } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';
import { sendEmail, generateEmailToken, verificationLink } from '@/lib/email';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not signed in' });
  if (user.emailVerifiedAt) return res.status(200).json({ ok: true, alreadyVerified: true });

  const rl = await limit({ key: `verify:${user.id}`, ...BUCKETS.verifyEmail });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many verification attempts' });
  }

  // Invalidate previous unused tokens so only the latest link works.
  await prisma.emailToken.updateMany({
    where: { userId: user.id, purpose: 'verify_email', usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateEmailToken();
  await prisma.emailToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      purpose: 'verify_email',
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    },
  });
  try {
    await sendEmail({
      to: user.email,
      subject: 'Verify your RemoteConnectMe account',
      text: `Click to verify (expires in 24h):\n\n${verificationLink(plaintext)}`,
    });
  } catch (e) {
    console.error('[resend-verification] email send failed', e);
  }
  await writeAudit({ action: 'auth.email_verify_sent', userId: user.id, req });
  return res.status(200).json({ ok: true });
}
