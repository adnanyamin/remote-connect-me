import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getDeviceFromRequest, signSignalingToken } from '@/lib/auth';

/**
 * Called by the Electron client (host) periodically. It exchanges its long-lived
 * device key for a short-lived signaling JWT, and also picks up any settings
 * the host needs to honor (currently: requireApproval).
 *
 * Auth: Bearer <deviceId>.<secret>
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const device = await getDeviceFromRequest(req);
  if (!device) return res.status(401).json({ error: 'invalid device key' });

  await prisma.device.update({
    where: { id: device.id }, data: { lastSeenAt: new Date() },
  });

  const token = signSignalingToken({ userId: device.userId, deviceId: device.id, role: 'host' });
  return res.status(200).json({
    token,
    deviceId: device.id,
    // Host uses this to decide whether to prompt the local user before
    // starting the WebRTC offer for an incoming viewer.
    requireApproval: device.requireApproval,
  });
}
