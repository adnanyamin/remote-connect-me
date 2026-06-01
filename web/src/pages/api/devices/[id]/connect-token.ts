import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { signSignalingToken } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { requireOrgRole } from '@/lib/org';

/**
 * Mints a short-lived JWT the browser uses to connect to the signaling server
 * as the *viewer* for a specific device. The signaling server validates this
 * with SIGNALING_SECRET and routes the socket into the right room.
 *
 * Requires technician+ role: viewers can list devices but not connect.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const auth = await requireOrgRole(req, res, 'technician');
  if (!auth.ok) return;
  const { ctx } = auth;
  if (!ctx.user.emailVerifiedAt) {
    return res.status(403).json({ error: 'verify your email first' });
  }

  const id = String(req.query.id);
  const device = await prisma.device.findFirst({ where: { id, orgId: ctx.org.id } });
  if (!device) return res.status(404).json({ error: 'not found' });
  if (device.deviceKeyHash === 'unpaired') {
    return res.status(409).json({ error: 'device not yet paired' });
  }

  const token = signSignalingToken({ userId: ctx.user.id, deviceId: device.id, role: 'viewer' });
  await writeAudit({
    action: 'device.connect_token',
    userId: ctx.user.id,
    orgId: ctx.org.id,
    targetType: 'device',
    targetId: device.id,
    req,
  });
  return res.status(200).json({
    token,
    // Lets the viewer decide whether to record this session and whether the
    // user may turn it off.
    recordingPolicy: ctx.org.recordingPolicy,
  });
}
