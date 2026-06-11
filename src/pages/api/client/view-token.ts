import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getDeviceFromAuthHeader, signSignalingToken } from '@/lib/auth';

/**
 * Issues a short-lived viewer JWT for the built-in Electron viewer window.
 * The requesting device must belong to the same user as the target device.
 *
 * Auth: Bearer <deviceId>.<secret>
 * Body: { targetDeviceId }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const device = await getDeviceFromAuthHeader(req);
  if (!device) return res.status(401).json({ error: 'invalid device key' });

  const { targetDeviceId } = req.body ?? {};
  if (!targetDeviceId) return res.status(400).json({ error: 'missing targetDeviceId' });

  const target = await prisma.device.findUnique({ where: { id: targetDeviceId } });
  if (!target || target.userId !== device.userId) {
    return res.status(403).json({ error: 'target device not found or access denied' });
  }

  const token = signSignalingToken({
    userId: device.userId,
    deviceId: target.id,
    role: 'viewer',
  });

  return res.status(200).json({ token });
}
