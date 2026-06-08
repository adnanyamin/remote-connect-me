import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { hashEmailToken } from '@/lib/email';
import { writeAudit } from '@/lib/audit';

const Body = z.object({ token: z.string().min(10).max(200) });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid token' });

  const tokenHash = hashEmailToken(parsed.data.token);
  const record = await prisma.emailToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!record || record.purpose !== 'verify_email') {
    return res.status(404).json({ error: 'token not found' });
  }
  if (record.usedAt) return res.status(409).json({ error: 'token already used' });
  if (record.expiresAt < new Date()) return res.status(410).json({ error: 'token expired' });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await writeAudit({ action: 'auth.email_verified', userId: record.userId, req });
  return res.status(200).json({ ok: true, email: record.user.email });
}
