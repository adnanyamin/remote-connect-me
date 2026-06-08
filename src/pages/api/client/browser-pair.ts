import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { getSessionUser, generateDeviceKey } from '@/lib/auth';
import { limit, BUCKETS, clientIp } from '@/lib/ratelimit';
import { writeAudit } from '@/lib/audit';

/**
 * Browser-based device pairing endpoint.
 *
 * Called from the /pair web page (user is already logged in via session cookie).
 * Creates a Device + deviceKey, then returns the redirect URL that sends
 * the credentials back to the Electron client's local HTTP callback server.
 *
 * in:  { deviceName, platform, callbackUrl }
 * out: { redirectUrl }  — the client is listening on callbackUrl
 */

const Body = z.object({
  deviceName:  z.string().min(1).max(120),
  platform:    z.string().max(40).optional().default('windows'),
  callbackUrl: z.string().url().refine(
    (u) => {
      try {
        const { hostname } = new URL(u);
        // Only allow loopback callbacks — never redirect credentials elsewhere.
        return hostname === '127.0.0.1' || hostname === 'localhost';
      } catch { return false; }
    },
    { message: 'callbackUrl must point to 127.0.0.1 or localhost' },
  ),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // Must be logged in
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  if (!user.emailVerifiedAt) return res.status(403).json({ error: 'email not verified' });

  const ip = clientIp(req);
  const rl = await limit({ key: `browser-pair:${user.id}:${ip}`, ...BUCKETS.pair });
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'too many pair attempts' });
  }

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid input' });
  }

  const { deviceName, platform, callbackUrl } = parsed.data;

  // Use the user's first (personal) org
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) return res.status(500).json({ error: 'no org found for user' });

  // Pre-generate device ID so we can include it in the device key before the INSERT
  const deviceId = crypto.randomBytes(12).toString('base64url'); // cuid-compatible length
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
    metadata: { method: 'browser', deviceName, platform },
  });

  // Build the redirect URL — delivers credentials to the Electron local server
  const redirect = new URL(callbackUrl);
  redirect.searchParams.set('deviceKey', deviceKey);
  redirect.searchParams.set('deviceId', device.id);

  return res.status(200).json({ redirectUrl: redirect.toString() });
}
