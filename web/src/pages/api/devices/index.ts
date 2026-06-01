import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { generatePairCode } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { requireOrgRole } from '@/lib/org';

const PAIR_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * GET  /api/devices         — list devices in the active org (viewer+)
 * POST /api/devices         — create a device + pair code (admin+)
 *
 * All queries are scoped to the caller's active org. Cross-org access is
 * impossible: members can only see devices in orgs they're a member of.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const auth = await requireOrgRole(req, res, 'viewer');
    if (!auth.ok) return;
    const { ctx } = auth;
    const devices = await prisma.device.findMany({
      where: { orgId: ctx.org.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, platform: true, lastSeenAt: true, createdAt: true,
        requireApproval: true,
      },
    });
    return res.status(200).json({ devices });
  }

  if (req.method === 'POST') {
    const auth = await requireOrgRole(req, res, 'admin');
    if (!auth.ok) return;
    const { ctx } = auth;
    if (!ctx.user.emailVerifiedAt) {
      return res.status(403).json({ error: 'verify your email before adding a device' });
    }
    const Body = z.object({ name: z.string().min(1).max(80) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid name' });

    const device = await prisma.device.create({
      data: {
        userId: ctx.user.id,
        orgId: ctx.org.id,
        name: parsed.data.name,
        // Until paired, the key hash is a sentinel that bcrypt-rejects everything.
        deviceKeyHash: 'unpaired',
      },
    });
    const code = generatePairCode();
    await prisma.pairCode.create({
      data: { code, deviceId: device.id, expiresAt: new Date(Date.now() + PAIR_TTL_MS) },
    });
    await writeAudit({
      action: 'device.create',
      userId: ctx.user.id,
      orgId: ctx.org.id,
      targetType: 'device',
      targetId: device.id,
      req,
      metadata: { name: parsed.data.name },
    });
    return res.status(200).json({
      device: { id: device.id, name: device.name },
      pairCode: code,
      expiresAt: new Date(Date.now() + PAIR_TTL_MS).toISOString(),
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
