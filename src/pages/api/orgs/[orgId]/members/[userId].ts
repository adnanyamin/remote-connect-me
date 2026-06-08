import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { requireOrgRoleByPath } from '@/lib/org';
import { hasRole, isRole, ROLE_RANK } from '@/lib/rbac';

/**
 * PATCH  /api/orgs/[orgId]/members/[userId]  { role }  — change a member's role
 * DELETE /api/orgs/[orgId]/members/[userId]            — remove a member
 *
 * Role-change rules:
 *   - Admin can change technician/viewer role to any non-owner role
 *   - Only an owner can promote to admin or demote an admin
 *   - Nobody can promote to owner via this endpoint (transfer ownership is a
 *     separate flow we haven't built yet — there is exactly one owner per org)
 *   - You cannot change your own role (leave/transfer are explicit actions)
 *
 * Removal rules:
 *   - Admin can remove technician/viewer
 *   - Only an owner can remove another admin
 *   - Removing yourself ("leave") is allowed unless you are the sole owner
 *   - Removing the sole owner is blocked
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const orgId = String(req.query.orgId);
  const targetUserId = String(req.query.userId);

  // We let a user leave themselves (DELETE self) at any role, so the gate
  // at this point is just "you're a member of this org". Per-action permission
  // checks happen inside the method blocks once we know the target row.
  const auth = await requireOrgRoleByPath(req, res, orgId, 'viewer');
  if (!auth.ok) return;
  const { ctx } = auth;

  const target = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: targetUserId, orgId } },
    include: { user: { select: { email: true } } },
  });
  if (!target) return res.status(404).json({ error: 'not found' });
  if (!isRole(target.role)) return res.status(500).json({ error: 'target has invalid role' });

  const selfAction = targetUserId === ctx.user.id;

  if (req.method === 'PATCH') {
    // Only admin+ can change roles. (Members can leave but not retitle themselves.)
    if (!hasRole(ctx.role, 'admin')) {
      return res.status(403).json({ error: 'requires admin role or higher' });
    }
    if (selfAction) {
      return res.status(400).json({ error: 'you can\'t change your own role' });
    }

    const Body = z.object({ role: z.string() });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success || !isRole(parsed.data.role)) {
      return res.status(400).json({ error: 'invalid role' });
    }
    const newRole = parsed.data.role;
    if (newRole === 'owner') {
      return res.status(400).json({ error: 'use the transfer-ownership flow to assign owner' });
    }
    // Touching anyone admin-or-higher (and promoting *into* admin) is owner-only.
    const requiresOwner =
      ROLE_RANK[target.role] >= ROLE_RANK['admin'] || ROLE_RANK[newRole] >= ROLE_RANK['admin'];
    if (requiresOwner && ctx.role !== 'owner') {
      return res.status(403).json({ error: 'only the owner can change an admin\'s role' });
    }

    await prisma.membership.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { role: newRole },
    });
    await writeAudit({
      action: 'org.member.role_change',
      userId: ctx.user.id,
      orgId,
      targetType: 'membership',
      targetId: target.id,
      req,
      metadata: { targetEmail: target.user.email, from: target.role, to: newRole },
    });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const isLeave = selfAction;
    // Permission check for non-self removals: admin+ for technician/viewer,
    // owner only when removing another admin.
    if (!isLeave) {
      if (!hasRole(ctx.role, 'admin')) {
        return res.status(403).json({ error: 'requires admin role or higher' });
      }
      if (ROLE_RANK[target.role] >= ROLE_RANK['admin'] && ctx.role !== 'owner') {
        return res.status(403).json({ error: 'only the owner can remove another admin' });
      }
    }
    // Never remove the sole owner — would orphan the org.
    if (target.role === 'owner') {
      const ownerCount = await prisma.membership.count({
        where: { orgId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'this is the only owner — transfer ownership before removing',
        });
      }
    }

    await prisma.membership.delete({
      where: { userId_orgId: { userId: targetUserId, orgId } },
    });
    await writeAudit({
      action: isLeave ? 'org.member.leave' : 'org.member.remove',
      userId: ctx.user.id,
      orgId,
      targetType: 'membership',
      targetId: target.id,
      req,
      metadata: { targetEmail: target.user.email, formerRole: target.role },
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
