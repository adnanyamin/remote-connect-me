import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash } from 'crypto';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { verifyEmailOtpPendingToken, generateDeviceKey } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

/**
 * In-app device pairing endpoint (Electron client).
 *
 * Flow:
 *   1. User enters email + password in the Electron pair window.
 *   2. Client calls /api/auth/login  → gets { emailOtpToken }
 *   3. User enters the 6-digit code sent to their email.
 *   4. Client calls this endpoint with { emailOtpToken, code, deviceName, platform }
 *   5. We verify the OTP, create a Device, and return { deviceKey, deviceId } directly.
 *      No session cookie is created — the device key IS the credential.
 */

const Body = z.object({
  emailOtpToken: z.string().min(1),
  code:          z.string().length(6),
  deviceName:    z.string().min(1).max(120),
  platform:      z.string().max(40).optional().default('windows'),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid input' });
  }

  const { emailOtpToken, code, deviceName, platform } = parsed.data;

  // Verify the pending-login JWT issued by /api/auth/login
  const payload = verifyEmailOtpPendingToken(emailOtpToken);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });

  const ip = clientIp(req);
  const rl = await limit({ key: `app-pair:${ip}:${payload.sub}`, ...BUCKETS.authLogin });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }

  // Verify OTP code
  const codeHash = createHash('sha256').update(code).digest('hex');
  const record = await prisma.emailToken.findFirst({
    where: {
      userId:   payload.sub,
      tokenHash: codeHash,
      purpose:  'login_otp',
      usedAt:   null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!record) {
    await writeAudit({ action: 'auth.email_otp.fail', userId: payload.sub, req });
    return res.status(401).json({ error: 'invalid or expired code' });
  }

  // Mark token used
  await prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: 'user not found' });
  if (!user.emailVerifiedAt) return res.status(403).json({ error: 'email not verified' });

  // Get first org membership
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) return res.status(500).json({ error: 'no org found for user' });

  // Create device + device key
  const deviceId = crypto.randomBytes(12).toString('base64url');
  const { plaintext: deviceKey, hash: deviceKeyHash } = await generateDeviceKey(deviceId);

  const device = await prisma.device.create({
    data: {
      id: deviceId,
      userId: user.id,
      orgId: membership.orgId,
      name: deviceName,
      platform,
      deviceKeyHash,
    },
  });

  await writeAudit({
    action: 'device.pair',
    userId: user.id,
    orgId: membership.orgId,
    targetType: 'device',
    targetId: device.id,
    req,
    metadata: { method: 'app', deviceName, platform },
  });

  return res.status(200).json({ deviceKey, deviceId: device.id });
}
