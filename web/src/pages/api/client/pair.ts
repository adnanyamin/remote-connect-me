import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { generateDeviceKey } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

/**
 * Called by the Electron client after the user pastes the pair code.
 *  in: { code: "ABCD1234", machineName?: "Adnan-PC", platform?: "windows" }
 *  out: { deviceId, deviceKey, accountEmail }
 *
 * The plaintext deviceKey is shown to the client EXACTLY ONCE here. The client
 * must store it (we recommend OS keychain) — the server only retains the bcrypt hash.
 */
const Body = z.object({
  code: z.string().length(8),
  machineName: z.string().max(120).optional(),
  platform: z.string().max(40).optional(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const ip = clientIp(req);
  const rl = await limit({ key: `pair:${ip}`, ...BUCKETS.pair });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    await writeAudit({ action: 'device.pair.fail', req, metadata: { result: 'rate_limited' } });
    return res.status(429).json({ error: 'too many pair attempts' });
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  const code = parsed.data.code.toUpperCase();

  const pair = await prisma.pairCode.findUnique({
    where: { code },
    include: { device: { include: { user: true, org: true } } },
  });
  if (!pair) {
    await writeAudit({
      action: 'device.pair.fail', req,
      metadata: { result: 'not_found', code },
    });
    return res.status(404).json({ error: 'invalid pair code' });
  }
  if (pair.usedAt) {
    await writeAudit({
      action: 'device.pair.fail', orgId: pair.device.orgId, req,
      metadata: { result: 'already_used', deviceId: pair.deviceId },
    });
    return res.status(409).json({ error: 'pair code already used' });
  }
  if (pair.expiresAt < new Date()) {
    await writeAudit({
      action: 'device.pair.fail', orgId: pair.device.orgId, req,
      metadata: { result: 'expired', deviceId: pair.deviceId },
    });
    return res.status(410).json({ error: 'pair code expired' });
  }
  if (!pair.device.user.emailVerifiedAt) {
    await writeAudit({
      action: 'device.pair.fail', userId: pair.device.userId, orgId: pair.device.orgId, req,
      metadata: { result: 'email_not_verified' },
    });
    return res.status(403).json({ error: 'account email not verified' });
  }

  const { plaintext, hash } = await generateDeviceKey(pair.deviceId);

  await prisma.$transaction([
    prisma.device.update({
      where: { id: pair.deviceId },
      data: {
        deviceKeyHash: hash,
        name: parsed.data.machineName || pair.device.name,
        platform: parsed.data.platform || 'windows',
      },
    }),
    prisma.pairCode.update({ where: { id: pair.id }, data: { usedAt: new Date() } }),
  ]);

  await writeAudit({
    action: 'device.pair',
    userId: pair.device.userId,
    orgId: pair.device.orgId,
    targetType: 'device',
    targetId: pair.deviceId,
    req,
    metadata: { machineName: parsed.data.machineName, platform: parsed.data.platform },
  });

  return res.status(200).json({
    deviceId: pair.deviceId,
    deviceKey: plaintext,
    accountEmail: pair.device.user.email,
  });
}
