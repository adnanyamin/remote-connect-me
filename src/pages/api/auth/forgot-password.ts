import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { generateEmailToken, sendEmail } from '@/lib/email';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

const Body = z.object({ email: z.string().email() });
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const email = parsed.data.email.toLowerCase();

  const ip = clientIp(req);
  const rl = await limit({ key: `forgot:${ip}`, ...BUCKETS.verifyEmail });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many requests, try again later' });
  }

  // Always return 200 to avoid leaking whether the email exists
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(200).json({ ok: true });

  const { plaintext, hash } = generateEmailToken();
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.emailToken.create({
    data: { userId: user.id, tokenHash: hash, purpose: 'password_reset', expiresAt: expires },
  });

  const link = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(plaintext)}`;

  try {
    await sendEmail({
      to: user.email,
      subject: 'Reset your RemoteConnectMe password',
      text: `Click the link below to reset your password. It expires in 1 hour.\n\n${link}\n\nIf you did not request this, you can safely ignore this email.`,
      html: `<p>Click the link below to reset your password. It expires in 1 hour.</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
    });
  } catch (e) {
    console.error('[forgot-password] email send failed', e);
  }

  await writeAudit({ action: 'auth.password_reset.requested', userId: user.id, req });
  return res.status(200).json({ ok: true });
}
