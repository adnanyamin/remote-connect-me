import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';

/**
 * POST /api/orgs/[orgId]/transfer  { toUserId, demoteTo? }
 *
 * Atomic ownership transfer: the calling owner becomes `demoteTo` (default
 * "admin"), the named member becomes the new owner. Wrapped in a transaction
 * so an org is never left with zero or two owners.
 *
 * Constraints:
 *   - Only the current owner can call this.
 *   - The target must already be a member.
 *   - You can't transfer to yourself (no-op, but worth a clear error).
 *   - `demoteTo` must be a non-owner role.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const orgId = String(req.query.orgId);
  const auth = await requireOrgRoleByPath(req, res, orgId, 'owner');
  if (!auth.ok) return;
  const { ctx } = auth;

  const Body = z.object({
    toUserId: z.string().min(1),
    demoteTo: z.enum(['admin', 'technician', 'viewer']).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid input' });
  if (parsed.data.toUserId === ctx.user.id) {
    return res.status(400).json({ error: 'you are already the owner' });
  }
  const demoteTo = parsed.data.demoteTo ?? 'admin';

  const target = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: parsed.data.toUserId, orgId } },
    include: { user: { select: { email: true } } },
  });
  if (!target) return res.status(404).json({ error: 'not a member of this org' });

  await prisma.$transaction([
    prisma.membership.update({
      where: { userId_orgId: { userId: ctx.user.id, orgId } },
      data: { role: demoteTo },
    }),
    prisma.membership.update({
      where: { userId_orgId: { userId: parsed.data.toUserId, orgId } },
      data: { role: 'owner' },
    }),
  ]);

  await writeAudit({
    action: 'org.member.role_change',
    userId: ctx.user.id,
    orgId,
    targetType: 'org',
    targetId: orgId,
    req,
    metadata: {
      kind: 'ownership_transfer',
      from: { userId: ctx.user.id, email: ctx.user.email, newRole: demoteTo },
      to:   { userId: parsed.data.toUserId, email: target.user.email, fromRole: target.role },
    },
  });

  return res.status(200).json({ ok: true, newOwner: parsed.data.toUserId, demotedTo: demoteTo });
}
