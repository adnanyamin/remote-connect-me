import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getDeviceFromAuthHeader } from '@/lib/auth';

/**
 * Returns all devices belonging to the same user as the requesting device.
 * Used by the built-in Electron viewer window to show a device list.
 *
 * Auth: Bearer <deviceId>.<secret>  (same as connect-token)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const device = await getDeviceFromAuthHeader(req);
  if (!device) return res.status(401).json({ error: 'invalid device key' });

  const devices = await prisma.device.findMany({
    where: { userId: device.userId },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, name: true, platform: true, lastSeenAt: true },
  });

  const now = Date.now();
  const result = devices.map((d) => ({
    deviceId: d.id,
    name: d.name,
    platform: d.platform,
    status: d.lastSeenAt && now - d.lastSeenAt.getTime() < 90_000 ? 'online' : 'offline',
    lastSeenAt: d.lastSeenAt,
  }));

  return res.status(200).json({ devices: result });
}
