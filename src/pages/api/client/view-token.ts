import type { NextApiRequest, NextApiResponse } from 'next';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import { signSignalingToken } from '@/lib/auth';

/**
 * Issues a short-lived viewer JWT for the built-in Electron viewer window.
 * The requesting device must belong to the same user as the target device.
 *
 * Auth: POST body { deviceId, deviceKey, targetDeviceId }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const { deviceId, deviceKey, targetDeviceId } = req.body ?? {};
  if (!deviceId || !deviceKey || !targetDeviceId) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  // Verify the requesting device
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return res.status(401).json({ error: 'invalid device' });

  const dot = String(deviceKey).indexOf('.');
  const secret = dot >= 0 ? String(deviceKey).slice(dot + 1) : '';
  const ok = await bcrypt.compare(secret, device.deviceKeyHash);
  if (!ok) return res.status(401).json({ error: 'invalid device key' });

  // Ensure target device belongs to the same user
  const target = await prisma.device.findUnique({ where: { id: targetDeviceId } });
  if (!target || target.userId !== device.userId) {
    return res.status(403).json({ error: 'target device not found or access denied' });
  }

  // Issue a viewer JWT scoped to the target device
  const token = signSignalingToken({
    userId: device.userId,
    deviceId: target.id,
    role: 'viewer',
  });

  return res.status(200).json({ token });
}
