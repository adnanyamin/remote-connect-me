import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRole } from '@/lib/org';

/**
 * GET    /api/devices/:id        — fetch device metadata (viewer+)
 * PATCH  /api/devices/:id        — update name / requireApproval (admin+)
 * DELETE /api/devices/:id        — remove a device (admin+)
 *
 * Devices are scoped by the caller's active org: a member of org A asking
 * for a device id that belongs to org B gets a 404, identical to a missing
 * device. We never leak whether a device exists in another tenant.
 *
 * The "active" org resolution comes from `requireOrgRole` (cookie or
 * personal org fallback) since the URL only carries the device id, not its
 * org. The device's actual orgId is then used to enforce scoping.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const minByMethod = req.method === 'GET' ? 'viewer' : 'admin';
  const auth = await requireOrgRole(req, res, minByMethod);
  if (!auth.ok) return;
  const { ctx } = auth;

  const id = String(req.query.id);
  const device = await prisma.device.findFirst({ where: { id, orgId: ctx.org.id } });
  if (!device) return res.status(404).json({ error: 'not found' });

  if (req.method === 'GET') {
    return res.status(200).json({
      id: device.id, name: device.name, platform: device.platform,
      requireApproval: device.requireApproval,
      lastSeenAt: device.lastSeenAt, createdAt: device.createdAt,
    });
  }

  if (req.method === 'PATCH') {
    const Body = z.object({
      name: z.string().min(1).max(80).optional(),
      requireApproval: z.boolean().optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid input' });

    const updated = await prisma.device.update({
      where: { id: device.id },
      data: parsed.data,
    });
    await writeAudit({
      action: 'device.update',
      userId: ctx.user.id,
      orgId: ctx.org.id,
      targetType: 'device',
      targetId: device.id,
      req,
      metadata: {
        // record only the fields that actually changed
        ...(parsed.data.name !== undefined && parsed.data.name !== device.name
          ? { name: { from: device.name, to: parsed.data.name } }
          : {}),
        ...(parsed.data.requireApproval !== undefined && parsed.data.requireApproval !== device.requireApproval
          ? { requireApproval: { from: device.requireApproval, to: parsed.data.requireApproval } }
          : {}),
      },
    });
    return res.status(200).json({
      id: updated.id, name: updated.name, platform: updated.platform,
      requireApproval: updated.requireApproval,
      lastSeenAt: updated.lastSeenAt, createdAt: updated.createdAt,
    });
  }

  if (req.method === 'DELETE') {
    await prisma.device.delete({ where: { id: device.id } });
    await writeAudit({
      action: 'device.delete',
      userId: ctx.user.id,
      orgId: ctx.org.id,
      targetType: 'device',
      targetId: device.id,
      req,
      metadata: { name: device.name },
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
