import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { hashEmailToken } from '@/lib/email';
import { hashPassword } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

const Body = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'password must be at least 8 characters' });

  const ip = clientIp(req);
  const rl = await limit({ key: `reset:${ip}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  const tokenHash = hashEmailToken(parsed.data.token);
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!record || record.purpose !== 'password_reset') {
    return res.status(404).json({ error: 'Invalid or expired reset link.' });
  }
  if (record.usedAt) return res.status(409).json({ error: 'This reset link has already been used.' });
  if (record.expiresAt < new Date()) return res.status(410).json({ error: 'This reset link has expired. Please request a new one.' });

  const newHash = await hashPassword(parsed.data.password);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash: newHash } }),
    prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  await writeAudit({ action: 'auth.password_reset.completed', userId: record.userId, req });
  return res.status(200).json({ ok: true });
}
