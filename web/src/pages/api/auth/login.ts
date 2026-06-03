import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  verifyPassword, signSessionToken, setSessionCookie, signMfaPendingToken,
  signEmailOtpPendingToken,
} from '@/lib/auth';
import { generateEmailToken } from '@/lib/email';
import { sendEmail } from '@/lib/email';
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

  // Always require email OTP before issuing a session.
  // Generate a 6-digit numeric code, store its hash, and email it.
  const { plaintext, hash } = generateEmailToken();
  const sixDigit = (parseInt(plaintext.slice(0, 8), 36) % 900000 + 100000).toString();
  const sixDigitHash = require('crypto').createHash('sha256').update(sixDigit).digest('hex');

  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await prisma.emailToken.create({
    data: {
      userId: user.id,
      tokenHash: sixDigitHash,
      purpose: 'login_otp',
      expiresAt: expires,
    },
  });

  try {
    await sendEmail({
      to: user.email,
      subject: 'Your RemoteConnectMe login code',
      text: `Your login verification code is: ${sixDigit}\n\nThis code expires in 10 minutes. If you did not attempt to log in, please ignore this email.`,
    });
  } catch (e) {
    console.error('[login] email OTP send failed', e);
  }

  // If MFA is also enrolled, chain: email OTP first, then TOTP.
  if (user.mfaEnabledAt) {
    await writeAudit({ action: 'auth.mfa.required', userId: user.id, req });
  }

  const emailOtpToken = signEmailOtpPendingToken(user.id);
  await writeAudit({ action: 'auth.email_otp.sent', userId: user.id, req });
  return res.status(200).json({
    email_otp_required: true,
    emailOtpToken,
    mfa_required: !!user.mfaEnabledAt,
  });
}
