import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { hashPassword, signSessionToken, setSessionCookie } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';
import { sendEmail, generateEmailToken, verificationLink } from '@/lib/email';
import { createPersonalOrg } from '@/lib/org';

const Body = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const ip = clientIp(req);
  const rl = await limit({ key: `signup:${ip}`, ...BUCKETS.authSignup });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    await writeAudit({ action: 'auth.signup', req, metadata: { result: 'rate_limited' } });
    return res.status(429).json({ error: 'too many signup attempts, try again later' });
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const { email, password } = parsed.data;
  const normalized = email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    await writeAudit({
      action: 'auth.signup', req,
      metadata: { result: 'email_in_use', email: normalized },
    });
    return res.status(409).json({ error: 'email already in use' });
  }

  // Atomically create the user, their personal org, and an owner membership.
  // If any step fails we don't want a half-built tenant lying around.
  const { user, org } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: normalized, passwordHash: await hashPassword(password) },
    });
    const { org } = await createPersonalOrg(tx, user);
    return { user, org };
  });

  // Issue + send verification token.
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
      subject: 'Verify your Remotely account',
      text:
        `Welcome to Remotely!\n\n` +
        `Click the link below to verify your email address (expires in 24h):\n\n` +
        `${verificationLink(plaintext)}\n\n` +
        `If you didn't sign up, you can ignore this email.`,
    });
  } catch (e) {
    // Don't fail signup if mail send fails; user can resend from the dashboard.
    console.error('[signup] email send failed', e);
  }

  setSessionCookie(res, signSessionToken(user.id));
  await writeAudit({
    action: 'auth.signup', userId: user.id, orgId: org.id, req,
    metadata: { email: normalized },
  });
  await writeAudit({ action: 'org.create', userId: user.id, orgId: org.id, targetType: 'org', targetId: org.id, req });
  await writeAudit({ action: 'auth.email_verify_sent', userId: user.id, orgId: org.id, req });

  return res.status(200).json({
    id: user.id,
    email: user.email,
    emailVerified: false,
    org: { id: org.id, name: org.name, slug: org.slug, role: 'owner' as const },
  });
}
