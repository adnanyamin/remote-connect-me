import type { NextApiRequest, NextApiResponse } from 'next';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';

/**
 * Returns all devices belonging to the same user as the requesting device.
 * Used by the built-in Electron viewer window to show device list.
 *
 * Auth: POST body { deviceId, deviceKey }  (deviceKey = "<deviceId>.<secret>")
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { deviceId, deviceKey } = req.body ?? {};
  if (!deviceId || !deviceKey) return res.status(400).json({ error: 'missing deviceId or deviceKey' });

  // Verify the requesting device
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return res.status(401).json({ error: 'invalid device' });

  // deviceKey format: "<deviceId>.<secret>"
  const dot = String(deviceKey).indexOf('.');
  const secret = dot >= 0 ? String(deviceKey).slice(dot + 1) : '';
  const ok = await bcrypt.compare(secret, device.deviceKeyHash);
  if (!ok) return res.status(401).json({ error: 'invalid device key' });

  // Return all devices for this user
  const devices = await prisma.device.findMany({
    where: { userId: device.userId },
    orderBy: { lastSeenAt: 'desc' },
    select: {
      id: true,
      name: true,
      platform: true,
      lastSeenAt: true,
    },
  });

  // Mark online if seen within the last 90 seconds
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
